// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import type { ContextGraphAuthorityIndexId } from '../src/chain-adapter.js';
import { ContextGraphAuthorityIndexRetryableError } from
  '../src/context-graph-authority-index.js';
import { RpcFailoverClient } from '../src/rpc-failover-client.js';
import { activeRpcRequestAbortSignal } from '../src/rpc-request-transport.js';
import { RPC_LOG_SCAN_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import { RpcEndpointsExhaustedError } from '../src/chain-rpc-transport-error.js';
import {
  createAbortableTipReader,
  MemoryAuthorityIndexStore,
} from './helpers/context-graph-authority-index.js';
import {
  AUTHORITY,
  createAuthorityScenario,
  GOVERNANCE,
  LATE_NAME_HASH,
  MEMBER,
  NAME_HASH,
  NEXT_POLICY_HASH,
  OWNER,
} from './helpers/context-graph-authority-scenario.js';

const authorityIndexId = (value: string): ContextGraphAuthorityIndexId => (
  value as ContextGraphAuthorityIndexId
);

interface IndexedAuthorityEvidence {
  readonly blockReads: Array<string | number>;
  readonly headReads: number[];
  readonly networkReads: bigint[];
  readonly filters: Array<readonly [string, ...unknown[]]>;
  readonly staticCalls: Array<readonly [bigint, { blockTag: number }]>;
  readonly readOptions: Array<Readonly<{
    policy?: string;
    signal?: AbortSignal;
    isRetryable?: (error: unknown) => boolean;
  }>>;
  readonly indexRanges: Array<readonly [number, number]>;
  readonly rejectedIndexRanges: Array<readonly [number, number]>;
  readonly transientFailedIndexRanges: Array<readonly [number, number]>;
  readonly indexTopicSets: string[][];
  readonly indexAddresses: string[];
  readonly indexInvalidations: number[];
  readonly indexPageSignals: AbortSignal[];
  readonly timedOutIndexRanges: Array<readonly [number, number]>;
}

interface IndexedAuthorityProvider {
  getBlockNumber(): Promise<number>;
  getBlock(tag: string | number): Promise<Readonly<{
    number: number;
    hash: string;
  }> | null>;
  getNetwork(): Promise<Readonly<{ chainId: bigint }>>;
  getLogs(filter: Readonly<{
    address: string;
    fromBlock: number;
    toBlock: number;
    topics: string[][];
  }>): Promise<readonly unknown[]>;
}

interface IndexedAuthorityHarness {
  readonly adapter: EVMChainAdapter;
  readonly evidence: IndexedAuthorityEvidence;
  readonly provider: IndexedAuthorityProvider;
  advanceAuthorityHead(): void;
  replaceAuthorityFork(): void;
  holdBlockRead(tag: string | number): Readonly<{ entered: Promise<void>; release(): void }>;
  holdHeadRead(): Readonly<{ entered: Promise<void>; release(): void }>;
  holdIndexPageRead(): Readonly<{ entered: Promise<void>; release(): void }>;
}

function makeIndexedAuthorityAdapter(
  options: Readonly<{
    deactivated?: boolean;
    secondContextGraph?: boolean;
    extraContextGraph?: Readonly<{ contextGraphId: bigint; nameHash: string }>;
    zeroHashContextGraphs?: number;
    lateContextGraphNameHash?: string;
    finalizedNumber?: number;
    finalizedHash?: string;
    authorityIndexPageSize?: number;
    maxLogRangeBlocks?: number;
    transientFailIndexRangeOnce?: readonly [number, number];
    hangIndexRangeOnce?: readonly [number, number];
    indexReadDelayMs?: number;
    authorityIndexStore?: MemoryAuthorityIndexStore;
    finalityConfirmations?: number;
    indexTickMs?: number;
    authorityIndexBootstrap?: import('../src/context-graph-authority-index-snapshot.js').ContextGraphAuthorityIndexBootstrap;
  }> = {},
): IndexedAuthorityHarness {
  const scenario = createAuthorityScenario(options);
  const authorityIndexStore = options.authorityIndexStore ?? new MemoryAuthorityIndexStore();
  const adapter: any = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: GOVERNANCE,
    privateKey: `0x${'11'.repeat(32)}`,
    allowNoAdminSigner: true,
    chainId: 'evm:31337',
    localContextGraphAuthorityIndexStore: authorityIndexStore,
    contextGraphAuthorityIndexBootstrap: options.authorityIndexBootstrap,
    ...(options.finalityConfirmations === undefined
      ? {}
      : { finalityConfirmations: options.finalityConfirmations }),
    ...(options.indexTickMs === undefined ? {} : { indexTickMs: options.indexTickMs }),
  });
  adapter.initialized = true;
  adapter.init = async () => {};
  adapter.cgRegistryScanPageSize = options.authorityIndexPageSize ?? 10;

  const evidence: IndexedAuthorityEvidence = {
    blockReads: [],
    headReads: [],
    networkReads: [],
    filters: [],
    staticCalls: [],
    readOptions: [],
    indexRanges: [],
    rejectedIndexRanges: [],
    transientFailedIndexRanges: [],
    indexTopicSets: [],
    indexAddresses: [],
    indexInvalidations: authorityIndexStore.invalidations,
    indexPageSignals: [],
    timedOutIndexRanges: [],
  };
  let indexPageReadGate: Readonly<{
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  }> | undefined;
  const transientFailIndexRange = options.transientFailIndexRangeOnce;
  let transientIndexFailurePending = transientFailIndexRange !== undefined;
  const hangIndexRange = options.hangIndexRangeOnce;
  let hungIndexRangePending = hangIndexRange !== undefined;

  const contract = {
    interface: {
      getEvent: (name: string) => ({ topicHash: `topic:${name}` }),
      parseLog: (log: { parsed: unknown }) => log.parsed,
    },
    filters: Object.fromEntries([
      'ContextGraphCreated',
      'ContextGraphDeactivated',
      'Transfer',
      'PublishPolicyUpdated',
      'PublishAuthorityUpdated',
      'AgentParticipantAdded',
      'AgentParticipantRemoved',
    ].map((name) => [
      name,
      (...args: readonly unknown[]) => {
        evidence.filters.push([name, ...args]);
        return { name, args };
      },
    ])),
    queryFilter: async () => {
      throw new Error('indexed authority snapshots must not use per-event queryFilter reads');
    },
    getContextGraph: {
      staticCall: async (contextGraphId: bigint, readOptions: { blockTag: number }) => {
        evidence.staticCalls.push([contextGraphId, readOptions]);
        return scenario.readCurrentState();
      },
    },
    getAddress: async () => GOVERNANCE,
  };

  const provider: IndexedAuthorityProvider = {
    getBlockNumber: async () => {
      const head = await scenario.getBlockNumber();
      evidence.headReads.push(head);
      return head;
    },
    getBlock: async (tag) => {
      const block = await scenario.getBlock(tag);
      // The head is read as `getBlock('latest')`; record it as a HEAD read
      // rather than as a numbered anchor/fence read.
      if (tag === 'latest') evidence.headReads.push(block.number);
      else evidence.blockReads.push(tag);
      return block;
    },
    getNetwork: async () => {
      evidence.networkReads.push(31337n);
      return { chainId: 31337n };
    },
    getLogs: async (filter) => {
      const requestSignal = activeRpcRequestAbortSignal();
      if (requestSignal !== undefined) evidence.indexPageSignals.push(requestSignal);
      expect(filter.address).toBe(GOVERNANCE);
      evidence.indexAddresses.push(filter.address);
      evidence.indexRanges.push([filter.fromBlock, filter.toBlock]);
      evidence.indexTopicSets.push(filter.topics[0] ?? []);
      if (
        transientIndexFailurePending
        && filter.fromBlock === transientFailIndexRange?.[0]
        && filter.toBlock === transientFailIndexRange?.[1]
      ) {
        transientIndexFailurePending = false;
        evidence.transientFailedIndexRanges.push([filter.fromBlock, filter.toBlock]);
        throw new Error('temporary authority-index provider failure');
      }
      if (
        options.maxLogRangeBlocks !== undefined
        && filter.toBlock - filter.fromBlock + 1 > options.maxLogRangeBlocks
      ) {
        if ((options.indexReadDelayMs ?? 0) > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, options.indexReadDelayMs);
          });
        }
        evidence.rejectedIndexRanges.push([filter.fromBlock, filter.toBlock]);
        throw Object.assign(new Error('server response 400 Bad Request'), {
          code: 'SERVER_ERROR',
          info: {
            responseBody: JSON.stringify({
              jsonrpc: '2.0',
              error: {
                message: `ranges over ${options.maxLogRangeBlocks} blocks are not supported on free plan`,
                code: 35,
              },
            }),
            responseStatus: '400 Bad Request',
          },
        });
      }
      if ((options.indexReadDelayMs ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, options.indexReadDelayMs);
        });
      }
      if (
        hungIndexRangePending
        && filter.fromBlock === hangIndexRange?.[0]
        && filter.toBlock === hangIndexRange?.[1]
      ) {
        hungIndexRangePending = false;
        evidence.timedOutIndexRanges.push([filter.fromBlock, filter.toBlock]);
        if (requestSignal === undefined) {
          throw new Error('hung authority-index request has no RPC cancellation signal');
        }
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(requestSignal.reason);
          requestSignal.addEventListener('abort', onAbort, { once: true });
          if (requestSignal.aborted) onAbort();
        });
      }
      const gate = indexPageReadGate;
      if (gate !== undefined) {
        indexPageReadGate = undefined;
        gate.entered.resolve();
        if (requestSignal === undefined) {
          await gate.release.promise;
        } else {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(requestSignal.reason);
            requestSignal.addEventListener('abort', onAbort, { once: true });
            void gate.release.promise.then(resolve, reject).finally(() => {
              requestSignal.removeEventListener('abort', onAbort);
            });
            if (requestSignal.aborted) onAbort();
          });
        }
      }
      return scenario.renderParsedLogs(filter.fromBlock, filter.toBlock);
    },
  };

  adapter.contracts = {
    contextGraphStorage: { connect: () => contract, getAddress: contract.getAddress },
  };
  adapter.readTipProvider = async (
    _label: string,
    read: (selectedProvider: IndexedAuthorityProvider) => Promise<unknown>,
    readOptions: IndexedAuthorityEvidence['readOptions'][number],
  ) => {
    evidence.readOptions.push(readOptions);
    return read(provider);
  };
  adapter.resolveContractDeployBlock = async () => ({
    fromBlock: 7,
    head: 30,
    scanProviders: [],
  });

  return {
    adapter: adapter as EVMChainAdapter,
    evidence,
    provider,
    advanceAuthorityHead: scenario.advanceAuthorityHead,
    replaceAuthorityFork: scenario.replaceAuthorityFork,
    holdBlockRead: scenario.holdBlockRead,
    holdHeadRead: scenario.holdHeadRead,
    holdIndexPageRead: () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      indexPageReadGate = { entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
  };
}

function bindAbortableTipReader(harness: IndexedAuthorityHarness): void {
  (harness.adapter as any).readTipProvider = createAbortableTipReader(
    harness.provider,
    (options) => { harness.evidence.readOptions.push(options); },
  );
}

function bindProductionRpcTipReader(
  harness: IndexedAuthorityHarness,
  providers: readonly IndexedAuthorityProvider[] = [harness.provider],
): void {
  const client = new RpcFailoverClient(
    () => providers.map((provider, index) => ({
      provider: provider as any,
      rpcUrl: `https://authority-${index + 1}.example`,
    })),
    async () => { throw new Error('authority read must not sign'); },
    () => 'evm:31337',
    { stickiness: { enabled: false } },
  );
  (harness.adapter as any).readTipProvider = (
    label: string,
    read: (provider: IndexedAuthorityProvider) => Promise<unknown>,
    options: IndexedAuthorityEvidence['readOptions'][number],
  ) => {
    harness.evidence.readOptions.push(options);
    return client.read(label, read as any, options);
  };
}

describe('RFC-64 indexed Context Graph authority snapshots', () => {
  it('rejects trusted-core bootstrap without a durable index store at construction', () => {
    const fetchSnapshot = vi.fn();
    expect(() => new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: GOVERNANCE,
      privateKey: `0x${'11'.repeat(32)}`,
      allowNoAdminSigner: true,
      chainId: 'evm:31337',
      contextGraphAuthorityIndexBootstrap: { trustDomain: 'core-peer-A', maxTailBlocks: 200, fetchSnapshot },
    })).toThrow('bootstrap requires a local durable index store');
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('exports cached core state and bootstraps an edge authority read through the adapter capability', async () => {
    const core = makeIndexedAuthorityAdapter();
    const snapshots = core.adapter.contextGraphAuthorityIndexSnapshots!;
    const request = {
      scope: `${core.adapter.deploymentId}:${GOVERNANCE}`,
      deploymentBlockNumber: 7, minThroughBlockNumber: 7, maxThroughBlockNumber: 30,
    };
    expect(await snapshots.exportSnapshot(request)).toBeNull();
    expect(core.evidence.headReads).toEqual([]);
    expect(core.evidence.indexRanges).toEqual([]);
    await snapshots.refresh();
    const ranges = core.evidence.indexRanges.length;
    expect(await snapshots.exportSnapshot(request)).toMatchObject({
      version: 1, scope: request.scope, checkpoint: { cursor: { throughBlockNumber: 30 } },
    });
    expect(await snapshots.exportSnapshot({ ...request, scope: 'another-deployment' })).toBeNull();
    expect(core.evidence.indexRanges).toHaveLength(ranges);

    const fetchSnapshot = vi.fn(async (requested, signal, validate) => {
      signal.throwIfAborted();
      const snapshot = await snapshots.exportSnapshot(requested);
      await validate(snapshot, signal);
      return snapshot;
    });
    const edge = makeIndexedAuthorityAdapter({ authorityIndexBootstrap: {
      trustDomain: 'core-peer-A', maxTailBlocks: 200, fetchSnapshot,
    } });
    await expect(edge.adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({ contextGraphId: '9' });
    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(edge.evidence.indexRanges).toEqual([]);
  });

  it('closes, aborts and drains an owned core refresh before reopening the adapter', async () => {
    const harness = makeIndexedAuthorityAdapter();
    const snapshots = harness.adapter.contextGraphAuthorityIndexSnapshots!;
    const gate = harness.holdIndexPageRead();
    const pending = snapshots.refresh();
    const rejected = expect(pending).rejects.toThrow('lifecycle cleared');
    await gate.entered;
    await snapshots.close();
    await rejected;
    expect(harness.evidence.indexPageSignals[0]?.aborted).toBe(true);
    const ranges = harness.evidence.indexRanges.length;
    await expect(snapshots.refresh()).rejects.toThrow('closed');
    expect(harness.evidence.indexRanges).toHaveLength(ranges);
    snapshots.open();
    await snapshots.refresh();
    gate.release();
  });

  it('also cancels a core refresh waiting for its chain head before any index page exists', async () => {
    const harness = makeIndexedAuthorityAdapter();
    const gate = harness.holdHeadRead();
    const snapshots = harness.adapter.contextGraphAuthorityIndexSnapshots!;
    const pending = snapshots.refresh();
    const rejected = expect(pending).rejects.toThrow('reader lifecycle closed');
    await gate.entered;
    await snapshots.close();
    await rejected;
    expect(harness.evidence.indexRanges).toEqual([]);
    gate.release();
  });

  it('plans authority-index pages within a 10,000-block provider cap', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      finalizedNumber: 20_020,
      authorityIndexPageSize: 25_000,
      maxLogRangeBlocks: 10_000,
    });

    await expect(adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .resolves.toEqual(new Map([[
        '9',
        expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      ]]));

    expect(evidence.indexRanges).toEqual([
      [7, 10_006],
      // Clamped to the durable horizon (head 20_020 less the reorg holdback)
      // so the persisted cursor never lands on a reorgable block.
      [10_007, 19_970],
      // The remainder is projected to the anchor but NOT written down.
      [19_971, 20_020],
    ]);
    expect(evidence.rejectedIndexRanges).toEqual([]);
    expect(evidence.headReads).toEqual([20_020]);
    // The tail's own boundary is the anchor, whose hash is already in hand, so
    // it costs no extra block read — only the horizon and the fence do.
    expect(evidence.blockReads).toEqual([10_006, 19_970, 20_020]);
  });

  it('does not turn an invalid authority page size into a valid bounded page', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      authorityIndexPageSize: Number.POSITIVE_INFINITY,
    });

    await expect(adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .rejects.toThrow('scan bounds are invalid');
    expect(evidence.indexRanges).toEqual([]);
  });

  it('adaptively splits a bounded authority page when a provider rejects a stricter cap', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      finalizedNumber: 10_020,
      authorityIndexPageSize: 25_000,
      maxLogRangeBlocks: 5_000,
    });

    await expect(adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .resolves.toEqual(new Map([[
        '9',
        expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      ]]));

    expect(evidence.indexRanges).toEqual([
      // The committing page stops at the durable horizon (10_020 less the
      // holdback), and the provider's stricter cap splits THAT range.
      [7, 9_970],
      [7, 4_988],
      [4_989, 9_970],
      // Tail above the horizon: projected, never persisted.
      [9_971, 10_020],
    ]);
    expect(evidence.rejectedIndexRanges).toEqual([[7, 9_970]]);
    expect(evidence.headReads).toEqual([10_020]);
    expect(evidence.blockReads).toEqual([9_970, 10_020]);
  });

  it('gives each sequential adaptive split its own physical RPC deadline', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeIndexedAuthorityAdapter({
        finalizedNumber: 10_006,
        authorityIndexPageSize: 25_000,
        maxLogRangeBlocks: 5_000,
        indexReadDelayMs: 20_000,
      });
      const backupReads: string[] = [];
      const backup: IndexedAuthorityProvider = {
        getBlockNumber: async () => {
          backupReads.push('head');
          return harness.provider.getBlockNumber();
        },
        getBlock: async (tag) => {
          backupReads.push(`block:${tag}`);
          return harness.provider.getBlock(tag);
        },
        getNetwork: async () => {
          backupReads.push('network');
          return harness.provider.getNetwork();
        },
        getLogs: async (filter) => {
          backupReads.push(`logs:${filter.fromBlock}-${filter.toBlock}`);
          return harness.provider.getLogs(filter);
        },
      };
      bindProductionRpcTipReader(harness, [harness.provider, backup]);

      const pending = harness.adapter.getContextGraphAuthoritySnapshot(9n);
      // Pump until the first page is in flight rather than counting microtask
      // turns: resolving the anchor costs a head read plus a block read, so a
      // fixed turn budget silently under-ran once the `finalized` tag went away.
      for (
        let turn = 0;
        turn < 100 && harness.evidence.indexRanges.length < 1;
        turn += 1
      ) await Promise.resolve();
      expect(harness.evidence.indexRanges).toEqual([[7, 9_956]]);

      // One advance per physical leg. The durable horizon adds a fourth: the
      // tail above it is projected on every read and never resumed from a
      // cursor, so it is a real extra `eth_getLogs` per authority scan.
      await vi.advanceTimersByTimeAsync(100_001);
      await expect(pending).resolves.toMatchObject({ contextGraphId: '9' });
      expect(harness.evidence.indexRanges).toEqual([
        // The committing page stops at the durable horizon and the provider's
        // stricter cap splits it; the fourth leg is the tail above the horizon.
        [7, 9_956],
        [7, 4_981],
        [4_982, 9_956],
        [9_957, 10_006],
      ]);
      expect(backupReads).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes from the last atomic checkpoint when a later bounded page fails', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      finalizedNumber: 20_020,
      authorityIndexPageSize: 25_000,
      transientFailIndexRangeOnce: [10_007, 19_970],
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    await expect(reader.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .rejects.toThrow('temporary authority-index provider failure');
    await expect(reader.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .resolves.toEqual(new Map([[
        '9',
        expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      ]]));

    expect(evidence.indexRanges).toEqual([
      [7, 10_006],
      [10_007, 19_970],
      [10_007, 19_970],
      // 19_970 is the durable horizon (head 20_020 less the reorg holdback), so
      // the last range is the TAIL: projected to the anchor, never written down,
      // and therefore re-read on the retry rather than resumed from a cursor
      // sitting on a block a reorg could take away.
      [19_971, 20_020],
    ]);
    expect(evidence.transientFailedIndexRanges).toEqual([[10_007, 19_970]]);
  });

  it('resumes a new authority-index instance at the first unfinished durable page', async () => {
    const authorityIndexStore = new MemoryAuthorityIndexStore();
    const first = makeIndexedAuthorityAdapter({
      authorityIndexStore,
      transientFailIndexRangeOnce: [17, 26],
    });
    await expect(first.adapter.getContextGraphAuthoritySnapshot(9n))
      .rejects.toThrow('temporary authority-index provider failure');
    expect(first.evidence.indexRanges).toEqual([[7, 16], [17, 26]]);

    const restarted = makeIndexedAuthorityAdapter({ authorityIndexStore });
    await expect(restarted.adapter.getContextGraphAuthoritySnapshot(9n))
      .resolves.toMatchObject({ contextGraphId: '9' });
    expect(restarted.evidence.indexRanges).toEqual([[17, 26], [27, 30]]);
    expect(restarted.evidence.headReads).toEqual([30]);
    expect(restarted.evidence.blockReads).toEqual([16, 26, 30]);
  });

  it('times out one hung physical page and fails over from the durable checkpoint', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeIndexedAuthorityAdapter({
        hangIndexRangeOnce: [17, 26],
      });
      bindProductionRpcTipReader(harness, [harness.provider, harness.provider]);

      const pending = harness.adapter.getContextGraphAuthoritySnapshot(9n);
      for (
        let turn = 0;
        turn < 100 && harness.evidence.indexRanges.length < 2;
        turn += 1
      ) await Promise.resolve();
      expect(harness.evidence.indexRanges).toEqual([[7, 16], [17, 26]]);

      await vi.advanceTimersByTimeAsync(RPC_LOG_SCAN_TIMEOUT_MS + 1);
      await expect(pending).resolves.toMatchObject({ contextGraphId: '9' });
      expect(harness.evidence.timedOutIndexRanges).toEqual([[17, 26]]);
      expect(harness.evidence.indexRanges).toEqual([
        [7, 16],
        [17, 26],
        [17, 26],
        [27, 30],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one combined contract-wide log request per page when the durable index is wired', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter();

    const snapshot = await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(snapshot).toMatchObject({
      contextGraphId: '9',
      owner: OWNER,
      active: true,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: '7',
      participantAgents: [OWNER, MEMBER],
      ownershipEra: '1',
      policyVersion: '3',
      rosterVersion: '3',
      sourceBlockNumber: '21',
    });
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
    expect(evidence.indexAddresses).toEqual(Array(3).fill(GOVERNANCE));
    expect(evidence.filters).toEqual([]);
    expect(evidence.indexTopicSets).toEqual(Array(3).fill([
      'topic:ContextGraphCreated',
      'topic:ContextGraphDeactivated',
      'topic:Transfer',
      'topic:PublishPolicyUpdated',
      'topic:PublishAuthorityUpdated',
      'topic:AgentParticipantAdded',
      'topic:AgentParticipantRemoved',
    ]));
    expect(evidence.staticCalls).toEqual([]);

    await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(evidence.indexRanges).toHaveLength(3);
    expect(evidence.staticCalls).toEqual([]);
  });

  it('completes three sequential durable pages whose aggregate runtime exceeds 30s', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeIndexedAuthorityAdapter({ indexReadDelayMs: 15_000 });
      const backupReads: string[] = [];
      const backup: IndexedAuthorityProvider = {
        getBlockNumber: async () => {
          backupReads.push('head');
          return harness.provider.getBlockNumber();
        },
        getBlock: async (tag) => {
          backupReads.push(`block:${tag}`);
          return harness.provider.getBlock(tag);
        },
        getNetwork: async () => {
          backupReads.push('network');
          return harness.provider.getNetwork();
        },
        getLogs: async (filter) => {
          backupReads.push(`logs:${filter.fromBlock}-${filter.toBlock}`);
          return harness.provider.getLogs(filter);
        },
      };
      bindProductionRpcTipReader(harness, [harness.provider, backup]);

      const pending = harness.adapter.getContextGraphAuthoritySnapshot(9n);
      await vi.advanceTimersByTimeAsync(45_001);
      await expect(pending).resolves.toMatchObject({ contextGraphId: '9' });
      expect(harness.evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
      expect(backupReads).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the durable contract-wide scan with reverse name-hash resolution', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter();
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    const [contextGraphId, snapshot] = await Promise.all([
      reader.resolveFinalizedContextGraphIdByNameHash!(NAME_HASH),
      adapter.getContextGraphAuthoritySnapshot(9n),
    ]);

    expect(contextGraphId).toBe(9n);
    expect(snapshot.contextGraphId).toBe('9');
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
    expect(evidence.filters).toEqual([]);

    await expect(reader.resolveFinalizedContextGraphIdByNameHash!(NAME_HASH))
      .resolves.toBe(9n);
    expect(evidence.indexRanges).toHaveLength(3);
  });

  it('keeps zero-hash opt-out slots out of finalized reverse binding', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      zeroHashContextGraphs: 2,
    });
    await adapter.getContextGraphAuthoritySnapshot(9n);

    await expect(adapter.contextGraphAuthorityIndexRevisionReader!
      .resolveFinalizedContextGraphIdByNameHash!(ethers.ZeroHash))
      .resolves.toBeNull();
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
  });

  it('rejects malformed finalized reverse-binding hashes before scanning', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter();

    await expect(adapter.contextGraphAuthorityIndexRevisionReader!
      .resolveFinalizedContextGraphIdByNameHash!('not-a-hash'))
      .rejects.toThrow('name-hash target must be bytes32');
    expect(evidence.indexRanges).toEqual([]);
  });

  it('projects many finalized name bindings through one index read', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      secondContextGraph: true,
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;
    const secondNameHash = `0x${'89'.repeat(32)}`;

    await expect(reader.resolveFinalizedContextGraphIdsByNameHashes!([
      NAME_HASH.toUpperCase().replace(/^0X/u, '0x'),
      secondNameHash,
      ethers.ZeroHash,
      `0x${'ff'.repeat(32)}`,
    ])).resolves.toEqual(new Map([
      [NAME_HASH, 9n],
      [secondNameHash, 10n],
    ]));
    expect(evidence.headReads).toEqual([30]);
    expect(evidence.blockReads).toEqual([16, 26, 30]);
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
  });

  it('resolves a Context Graph registered at the current head', async () => {
    // THE release blocker, as an assertion. The endpoint's `finalized` tag sits
    // ~600 blocks (~20 minutes) behind head on Base Sepolia, so a freshly
    // registered Context Graph was absent from the authority index for that
    // whole window: both nodes fenced each other's catalog traffic,
    // announcements were denied, and the replica permanently lost rows while
    // reporting itself complete. At the default depth of 1 the registration
    // block IS the anchor, so the Context Graph is authoritative immediately.
    const atHead = makeIndexedAuthorityAdapter({
      finalizedNumber: 33,
      finalizedHash: NEXT_POLICY_HASH,
      lateContextGraphNameHash: LATE_NAME_HASH,
    });

    await expect(atHead.adapter.contextGraphAuthorityIndexRevisionReader!
      .resolveFinalizedContextGraphIdByNameHash!(LATE_NAME_HASH))
      .resolves.toBe(11n);
    expect(atHead.evidence.blockReads).not.toContain('finalized');

    // Only the OPERATOR's configured depth can hold it back now, and holding it
    // back is then a deliberate choice rather than an endpoint's fixed policy.
    const behindHead = makeIndexedAuthorityAdapter({
      finalizedNumber: 33,
      finalizedHash: NEXT_POLICY_HASH,
      lateContextGraphNameHash: LATE_NAME_HASH,
      finalityConfirmations: 4,
    });

    await expect(behindHead.adapter.contextGraphAuthorityIndexRevisionReader!
      .resolveFinalizedContextGraphIdByNameHash!(LATE_NAME_HASH))
      .resolves.toBeNull();
  });

  it('does not retain a finalized miss after the authority index advances', async () => {
    const { adapter, evidence, advanceAuthorityHead } = makeIndexedAuthorityAdapter({
      lateContextGraphNameHash: LATE_NAME_HASH,
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    await expect(reader.resolveFinalizedContextGraphIdByNameHash!(LATE_NAME_HASH))
      .resolves.toBeNull();
    advanceAuthorityHead();
    await expect(reader.resolveFinalizedContextGraphIdByNameHash!(LATE_NAME_HASH))
      .resolves.toBe(11n);

    expect(evidence.indexRanges).toEqual([
      [7, 16], [17, 26], [27, 30],
      [31, 35],
    ]);
  });

  it('resolves name identity and authority state at one finalized horizon', async () => {
    const { adapter, evidence, advanceAuthorityHead } = makeIndexedAuthorityAdapter({
      lateContextGraphNameHash: NAME_HASH,
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    await expect(reader.resolveFinalizedContextGraphAuthoritySnapshotByNameHash!(NAME_HASH))
      .resolves.toMatchObject({
        contextGraphId: '9',
        nameHash: NAME_HASH,
        owner: OWNER,
        sourceBlockNumber: '21',
      });
    advanceAuthorityHead();
    await expect(reader.resolveFinalizedContextGraphAuthoritySnapshotByNameHash!(NAME_HASH))
      .rejects.toThrow('ambiguous across 2 finalized Context Graphs');

    expect(evidence.indexRanges).toEqual([
      [7, 16], [17, 26], [27, 30],
      [31, 35],
    ]);
  });

  it('resolves many complete name-bound snapshots at one anchor and fails a later duplicate closed', async () => {
    const { adapter, evidence, advanceAuthorityHead } = makeIndexedAuthorityAdapter({
      secondContextGraph: true,
      lateContextGraphNameHash: NAME_HASH,
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;
    const secondNameHash = `0x${'89'.repeat(32)}`;

    const snapshots = await reader
      .resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes!([
        NAME_HASH,
        secondNameHash,
        ethers.ZeroHash,
      ]);
    expect(snapshots.get(NAME_HASH)).toMatchObject({
      contextGraphId: '9',
      nameHash: NAME_HASH,
      owner: OWNER,
      sourceBlockNumber: '21',
    });
    expect(snapshots.get(secondNameHash)).toMatchObject({
      contextGraphId: '10',
      nameHash: secondNameHash,
      owner: MEMBER,
      sourceBlockNumber: '18',
    });
    expect(evidence.headReads).toEqual([30]);
    expect(evidence.blockReads).toEqual([16, 26, 30]);
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);

    advanceAuthorityHead();
    await expect(reader.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes!([
      NAME_HASH,
      secondNameHash,
    ])).rejects.toThrow('ambiguous across 2 finalized Context Graphs');
    expect(evidence.headReads).toHaveLength(2);
    expect(evidence.indexRanges).toEqual([
      [7, 16], [17, 26], [27, 30],
      [31, 35],
    ]);
  });

  it('projects stable per-CG revisions from one shared index advance', async () => {
    const { adapter, evidence, advanceAuthorityHead } = makeIndexedAuthorityAdapter({
      secondContextGraph: true,
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    const initial = await reader.readContextGraphAuthorityIndexRevisions(
      [authorityIndexId('9'), authorityIndexId('9'), authorityIndexId('10')],
    );
    expect(initial).toEqual(new Map([
      ['9', expect.stringMatching(/^0x[0-9a-f]{64}$/u)],
      ['10', expect.stringMatching(/^0x[0-9a-f]{64}$/u)],
    ]));
    expect(initial.get(authorityIndexId('9'))).not.toBe(
      initial.get(authorityIndexId('10')),
    );
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);

    const unchanged = await reader.readContextGraphAuthorityIndexRevisions([
      authorityIndexId('9'),
    ]);
    expect(unchanged).toEqual(new Map([[
      '9',
      initial.get(authorityIndexId('9')),
    ]]));
    expect(evidence.indexRanges).toHaveLength(3);

    advanceAuthorityHead();
    const advanced = await reader.readContextGraphAuthorityIndexRevisions([
      authorityIndexId('9'),
    ]);
    expect(advanced.size).toBe(1);
    expect(advanced.get(authorityIndexId('9'))).not.toBe(
      initial.get(authorityIndexId('9')),
    );
    expect(evidence.indexRanges.slice(3)).toEqual([[31, 35]]);
  });

  it('projects many authority snapshots through one finalized anchor and index scan', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      secondContextGraph: true,
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    await expect(reader.readContextGraphAuthorityIndexSnapshots!([
      authorityIndexId('9'),
      authorityIndexId('10'),
    ])).resolves.toEqual(new Map([
      ['9', expect.objectContaining({
        active: true,
        accessPolicy: 1,
        nameHash: NAME_HASH,
        chainId: '31337',
        governanceContract: GOVERNANCE.toLowerCase(),
      })],
      ['10', expect.objectContaining({
        active: true,
        accessPolicy: 1,
      })],
    ]));
    expect(evidence.headReads).toEqual([30]);
    expect(evidence.blockReads).toEqual([16, 26, 30]);
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
    expect(evidence.staticCalls).toEqual([]);
  });

  it('head-probes for the immutable deploy block ONCE — later snapshots and index projections issue no eth_blockNumber', async () => {
    // Both indexed consumers keep only `fromBlock`. The REAL deploy-block resolver runs here
    // (the fixture's stub is removed) so a regression to the probing variant is observable as
    // one `getBlockNumber()` per scan — ~1:1 with authority getLogs on a receiver.
    const { adapter, evidence, provider, advanceAuthorityHead } = makeIndexedAuthorityAdapter({
      secondContextGraph: true,
    });
    const raw = adapter as any;
    delete raw.resolveContractDeployBlock;
    raw.ensureConfiguredStaticChainIdValidated = async () => 31337n;
    let headProbes = 0;
    const codeReads: Array<number | undefined> = [];
    raw.providers = [{
      ...provider,
      getBlockNumber: async () => { headProbes += 1; return 30; },
      getCode: async (_address: string, block?: number) => {
        codeReads.push(block);
        return block === undefined || block >= 7 ? '0x6000' : '0x';
      },
    }];
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(headProbes).toBe(1); // the one-off miss: probe + binary search, as before
    expect(codeReads.length).toBeGreaterThan(1);
    expect(evidence.indexRanges[0]?.[0]).toBe(7); // the scan is anchored at the searched deploy block
    const searchReads = codeReads.length;

    await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(headProbes).toBe(1); // snapshot path: cache hit, no probe

    await reader.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]);
    await reader.readContextGraphAuthorityIndexSnapshots!([authorityIndexId('10')]);
    expect(headProbes).toBe(1); // index-reader dependency: cache hit, no probe

    advanceAuthorityHead();
    await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(evidence.indexRanges.at(-1)).toEqual([31, 35]); // a real scan ran — still no probe
    expect(headProbes).toBe(1);
    expect(codeReads).toHaveLength(searchReads);
  });

  it('bounds the ID-based snapshot network read as a physical durable RPC', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeIndexedAuthorityAdapter();
      const primaryNetworkSignals: AbortSignal[] = [];
      let backupNetworkReads = 0;
      const primary: IndexedAuthorityProvider = {
        ...harness.provider,
        getNetwork: async () => {
          const signal = activeRpcRequestAbortSignal();
          if (signal === undefined) {
            throw new Error('network read has no RPC cancellation signal');
          }
          primaryNetworkSignals.push(signal);
          await new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        },
      };
      const backup: IndexedAuthorityProvider = {
        ...harness.provider,
        getNetwork: async () => {
          backupNetworkReads += 1;
          return harness.provider.getNetwork();
        },
      };
      bindProductionRpcTipReader(harness, [primary, backup]);

      const pending = harness.adapter.contextGraphAuthorityIndexRevisionReader!
        .readContextGraphAuthorityIndexSnapshots!([authorityIndexId('9')]);
      for (
        let turn = 0;
        turn < 100 && primaryNetworkSignals.length === 0;
        turn += 1
      ) await Promise.resolve();
      expect(primaryNetworkSignals).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(RPC_LOG_SCAN_TIMEOUT_MS + 1);
      await expect(pending).resolves.toEqual(new Map([[
        '9',
        expect.objectContaining({ contextGraphId: '9', chainId: '31337' }),
      ]]));
      expect(primaryNetworkSignals[0]?.aborted).toBe(true);
      expect(backupNetworkReads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid indexed snapshot ids before deployment discovery or index ranges', async () => {
    for (const contextGraphId of [0n, ethers.MaxUint256 + 1n]) {
      const { adapter, evidence } = makeIndexedAuthorityAdapter();

      await expect(adapter.getContextGraphAuthoritySnapshot(contextGraphId))
        .rejects.toThrow('target id is invalid');
      expect(evidence.indexRanges).toEqual([]);
    }
  });

  it('binds a total revision capability only while the local index exists', async () => {
    const withoutIndex = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: GOVERNANCE,
      privateKey: `0x${'11'.repeat(32)}`,
      allowNoAdminSigner: true,
      chainId: 'evm:31337',
    });
    expect(withoutIndex.contextGraphAuthorityIndexRevisionReader).toBeUndefined();

    const { adapter } = makeIndexedAuthorityAdapter();
    const reader = adapter.contextGraphAuthorityIndexRevisionReader;
    expect(reader).toBeDefined();
    await expect(reader!.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .resolves.toEqual(new Map([[
        '9',
        expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      ]]));

    (adapter as any).contextGraphAuthorityIndex = undefined;
    await expect(reader!.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .resolves.toBeInstanceOf(Map);
  });

  it('validates revision targets and projects an oversized set from one finalized scan', async () => {
    const boundaryId = 4_097n;
    const boundaryNameHash = ethers.zeroPadValue(ethers.toBeHex(boundaryId), 32);
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      extraContextGraph: { contextGraphId: boundaryId, nameHash: boundaryNameHash },
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    await expect(reader.readContextGraphAuthorityIndexRevisions([])).resolves.toEqual(new Map());
    for (const invalidId of ['0', (ethers.MaxUint256 + 1n).toString(10)]) {
      await expect(reader.readContextGraphAuthorityIndexRevisions([
        invalidId as ContextGraphAuthorityIndexId,
      ]))
        .rejects.toThrow('target id is invalid');
    }
    // Targets used to be chunked into repeated index scans. They are now
    // projected in memory from the ONE view a finalized read scans.
    const view = vi.spyOn((adapter as any).contextGraphAuthorityIndex, 'view');
    await expect(reader.readContextGraphAuthorityIndexRevisions(
      Array.from({ length: 4_097 }, (_, index) => authorityIndexId(String(index + 1))),
    )).resolves.toEqual(new Map([
      ['9', expect.stringMatching(/^0x[0-9a-f]{64}$/u)],
      [boundaryId.toString(10), expect.stringMatching(/^0x[0-9a-f]{64}$/u)],
    ]));
    expect(view).toHaveBeenCalledOnce();
    expect(evidence.headReads).toHaveLength(1);
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
  });

  it('projects an oversized name-hash set from one finalized scan', async () => {
    const boundaryId = 4_097n;
    const boundaryNameHash = ethers.zeroPadValue(ethers.toBeHex(boundaryId), 32);
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      extraContextGraph: { contextGraphId: boundaryId, nameHash: boundaryNameHash },
    });
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;
    const view = vi.spyOn((adapter as any).contextGraphAuthorityIndex, 'view');
    const nameHashes = Array.from(
      { length: Number(boundaryId) },
      (_, index) => ethers.zeroPadValue(ethers.toBeHex(index + 1), 32),
    );

    await expect(reader.resolveFinalizedContextGraphIdsByNameHashes!(nameHashes))
      .resolves.toEqual(new Map([[boundaryNameHash, boundaryId]]));
    expect(view).toHaveBeenCalledOnce();
    expect(evidence.headReads).toHaveLength(1);
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
  });

  it('anchors the durable authority index at chain.finalityConfirmations', async () => {
    // GH release blocker: with the endpoint's `finalized` tag the durable index
    // could not see a freshly registered Context Graph for ~20 minutes on Base
    // Sepolia, so announcements were denied and the replica lost rows while
    // reporting itself complete. Finality is SINGULAR and operator-defined, so
    // the index anchors at head - confirmations + 1 and never asks for the tag.
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      finalityConfirmations: 4,
    });

    await expect(adapter.getContextGraphAuthoritySnapshot(9n))
      .resolves.toMatchObject({ contextGraphId: '9' });

    expect(evidence.headReads).toEqual([30]);
    // head 30 at depth 4 pins 30 - 4 + 1 = 27, read FIRST and fenced LAST.
    expect(evidence.blockReads[0]).toBe(27);
    expect(evidence.blockReads.at(-1)).toBe(27);
    expect(evidence.blockReads).not.toContain('finalized');
    expect(evidence.staticCalls).toEqual([]);
    // The durable page scan stops at the anchor; nothing above it is indexed.
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 27]]);
  });

  it('anchors the durable revision reader at chain.finalityConfirmations', async () => {
    // The shared revision/name-hash reader resolves its own anchor, so it needs
    // its own pin: a fix applied only to the snapshot path would leave named-CG
    // resolution waiting on the endpoint's ~20-minute `finalized` marker.
    const { adapter, evidence } = makeIndexedAuthorityAdapter({
      finalityConfirmations: 4,
    });

    await expect(adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .resolves.toEqual(new Map([[
        '9',
        expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      ]]));

    expect(evidence.headReads).toEqual([30]);
    expect(evidence.blockReads[0]).toBe(27);
    expect(evidence.blockReads.at(-1)).toBe(27);
    expect(evidence.blockReads).not.toContain('finalized');
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 27]]);
  });

  it('follows the head at the default depth of one', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter();

    await expect(adapter.getContextGraphAuthoritySnapshot(9n))
      .resolves.toMatchObject({ contextGraphId: '9' });

    // Confirmation 1 IS the head, which is the whole point of the default: a
    // Context Graph registered one block ago is already authoritative.
    expect(evidence.headReads).toEqual([30]);
    // The anchor IS that head block, so resolving it costs no second numbered
    // read — the round-trip a sibling backend of a load-balanced URL could
    // answer `null`. The first numbered read is the first PAGE boundary, and
    // the trailing one is the stabilization fence, which must still happen.
    expect(evidence.blockReads).toEqual([16, 26, 30]);
    expect(evidence.blockReads).not.toContain('finalized');
    expect(evidence.blockReads).not.toContain('latest');
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
  });

  it('rejects a stale revision projection and rebuilds the replacement fork', async () => {
    const harness = makeIndexedAuthorityAdapter();
    const stabilization = harness.holdBlockRead(30);
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    const stale = reader.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]);

    await stabilization.entered;
    harness.replaceAuthorityFork();
    stabilization.release();
    await expect(stale).rejects.toThrow('anchor changed');

    await expect(reader.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .resolves.toEqual(new Map([[
        '9',
        expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      ]]));
    expect(harness.evidence.indexInvalidations).toEqual([4]);
    expect(harness.evidence.indexRanges).toEqual([
      [7, 16], [17, 26], [27, 30],
      [7, 16], [17, 26], [27, 30],
    ]);
  });

  it('rejects a stale finalized name binding and rebuilds the replacement fork', async () => {
    const harness = makeIndexedAuthorityAdapter();
    const stabilization = harness.holdBlockRead(30);
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    const stale = reader.resolveFinalizedContextGraphIdByNameHash!(NAME_HASH);

    await stabilization.entered;
    harness.replaceAuthorityFork();
    stabilization.release();
    await expect(stale).rejects.toThrow('anchor changed');

    await expect(reader.resolveFinalizedContextGraphIdByNameHash!(NAME_HASH))
      .resolves.toBe(9n);
    expect(harness.evidence.indexInvalidations).toEqual([4]);
    expect(harness.evidence.indexRanges).toEqual([
      [7, 16], [17, 26], [27, 30],
      [7, 16], [17, 26], [27, 30],
    ]);
  });

  it.each([
    ['chain head', (harness: IndexedAuthorityHarness) => harness.holdHeadRead()],
    ['stabilization fence', (harness: IndexedAuthorityHarness) => harness.holdBlockRead(30)],
  ] as const)('keeps revision-reader cancellation bound during the indexed %s read', async (
    _stage,
    hold,
  ) => {
    const harness = makeIndexedAuthorityAdapter();
    bindAbortableTipReader(harness);
    const gate = hold(harness);
    const abort = new AbortController();
    const pending = harness.adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexRevisions([authorityIndexId('9')], {
        signal: abort.signal,
      });
    await gate.entered;
    expect(harness.evidence.readOptions[0]).toMatchObject({
      policy: 'durablePagedLogScan',
      signal: abort.signal,
    });
    expect(harness.evidence.readOptions[0]?.isRetryable?.(
      new ContextGraphAuthorityIndexRetryableError('retryable index read'),
    )).toBe(true);
    expect(harness.evidence.readOptions[0]?.isRetryable?.(
      new Error('programming failure'),
    )).toBe(false);
    abort.abort(new Error('revision caller left'));
    await expect(pending).rejects.toThrow('revision caller left');
    gate.release();
  });

  it.each([
    ['chain head', (harness: IndexedAuthorityHarness) => harness.holdHeadRead()],
    ['stabilization fence', (harness: IndexedAuthorityHarness) => harness.holdBlockRead(30)],
  ] as const)('keeps name-snapshot cancellation bound during the indexed %s read', async (
    _stage,
    hold,
  ) => {
    const harness = makeIndexedAuthorityAdapter();
    bindAbortableTipReader(harness);
    const gate = hold(harness);
    const abort = new AbortController();
    const pending = harness.adapter.contextGraphAuthorityIndexRevisionReader!
      .resolveFinalizedContextGraphAuthoritySnapshotByNameHash!(NAME_HASH, {
        signal: abort.signal,
      });
    await gate.entered;
    expect(harness.evidence.readOptions[0]).toMatchObject({
      policy: 'durablePagedLogScan',
      signal: abort.signal,
    });
    abort.abort(new Error('name-snapshot caller left'));
    await expect(pending).rejects.toThrow('name-snapshot caller left');
    gate.release();
  });

  it('propagates cancellation and retry policy for the finalized name resolver', async () => {
    const harness = makeIndexedAuthorityAdapter();
    bindAbortableTipReader(harness);
    const gate = harness.holdHeadRead();
    const abort = new AbortController();
    const pending = harness.adapter.contextGraphAuthorityIndexRevisionReader!
      .resolveFinalizedContextGraphIdByNameHash!(NAME_HASH, { signal: abort.signal });
    await gate.entered;
    expect(harness.evidence.readOptions[0]).toMatchObject({
      policy: 'durablePagedLogScan',
      signal: abort.signal,
    });
    expect(harness.evidence.readOptions[0]?.isRetryable?.(
      new ContextGraphAuthorityIndexRetryableError('retryable index read'),
    )).toBe(true);
    expect(harness.evidence.readOptions[0]?.isRetryable?.(
      new Error('programming failure'),
    )).toBe(false);
    abort.abort(new Error('name resolver caller left'));
    await expect(pending).rejects.toThrow('name resolver caller left');
    gate.release();
  });

  it('drains a detached physical name-snapshot scan before becoming idle', async () => {
    const harness = makeIndexedAuthorityAdapter();
    bindAbortableTipReader(harness);
    const gate = harness.holdIndexPageRead();
    const abort = new AbortController();
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    const cancelled = reader.resolveFinalizedContextGraphAuthoritySnapshotByNameHash!(
      NAME_HASH,
      { signal: abort.signal },
    );
    await gate.entered;
    abort.abort(new Error('name-snapshot owner closed'));
    await expect(cancelled).rejects.toThrow('name-snapshot owner closed');

    let idle = false;
    const drain = reader.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    gate.release();
    await drain;
    expect(idle).toBe(true);
  });

  it('drains a detached physical revision scan before the capability becomes idle', async () => {
    const harness = makeIndexedAuthorityAdapter();
    bindAbortableTipReader(harness);
    const gate = harness.holdIndexPageRead();
    const abort = new AbortController();
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    const cancelled = reader.readContextGraphAuthorityIndexRevisions([
      authorityIndexId('9'),
    ], { signal: abort.signal });
    await gate.entered;
    abort.abort(new Error('revision owner closed'));
    await expect(cancelled).rejects.toThrow('revision owner closed');

    let idle = false;
    const drain = reader.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    gate.release();
    await drain;
    expect(idle).toBe(true);
  });

  it('fails a revision scan over after a retryable index error', async () => {
    const harness = makeIndexedAuthorityAdapter();
    const attempts: string[] = [];
    const nonArchive: IndexedAuthorityProvider = {
      ...harness.provider,
      getBlock: async (tag) => {
        if (tag === 16) return null;
        return harness.provider.getBlock(tag);
      },
    };
    (harness.adapter as any).readTipProvider = async (
      label: string,
      read: (selected: IndexedAuthorityProvider) => Promise<unknown>,
      options: IndexedAuthorityEvidence['readOptions'][number],
    ) => {
      expect(label).toBe('readContextGraphAuthorityIndexRevisions');
      harness.evidence.readOptions.push(options);
      try {
        attempts.push('non-archive');
        return await read(nonArchive);
      } catch (error) {
        expect(error).toBeInstanceOf(ContextGraphAuthorityIndexRetryableError);
        expect(options.isRetryable?.(error)).toBe(true);
        attempts.push('healthy');
        return read(harness.provider);
      }
    };
    const abort = new AbortController();

    await expect(harness.adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexRevisions([authorityIndexId('9')], {
        signal: abort.signal,
      })).resolves.toEqual(new Map([[
      '9',
      expect.stringMatching(/^0x[0-9a-f]{64}$/u),
    ]]));
    expect(attempts).toEqual(['non-archive', 'healthy']);
    expect(harness.evidence.readOptions[0]).toMatchObject({
      policy: 'durablePagedLogScan',
      signal: abort.signal,
    });
  });

  it('fails a batch name projection over after a retryable index error', async () => {
    const harness = makeIndexedAuthorityAdapter();
    const attempts: string[] = [];
    const nonArchive: IndexedAuthorityProvider = {
      ...harness.provider,
      getBlock: async (tag) => {
        if (tag === 16) return null;
        return harness.provider.getBlock(tag);
      },
    };
    (harness.adapter as any).readTipProvider = async (
      label: string,
      read: (selected: IndexedAuthorityProvider) => Promise<unknown>,
      options: IndexedAuthorityEvidence['readOptions'][number],
    ) => {
      expect(label).toBe('resolveFinalizedContextGraphIdsByNameHashes');
      harness.evidence.readOptions.push(options);
      try {
        attempts.push('non-archive');
        return await read(nonArchive);
      } catch (error) {
        expect(error).toBeInstanceOf(ContextGraphAuthorityIndexRetryableError);
        expect(options.isRetryable?.(error)).toBe(true);
        attempts.push('healthy');
        return read(harness.provider);
      }
    };

    await expect(harness.adapter.contextGraphAuthorityIndexRevisionReader!
      .resolveFinalizedContextGraphIdsByNameHashes!([NAME_HASH]))
      .resolves.toEqual(new Map([[NAME_HASH, 9n]]));
    expect(attempts).toEqual(['non-archive', 'healthy']);
  });

  it('rejects an indexed reorg fence then invalidates and rebuilds the replacement fork', async () => {
    const harness = makeIndexedAuthorityAdapter();
    const stabilization = harness.holdBlockRead(30);
    const stale = harness.adapter.getContextGraphAuthoritySnapshot(9n);

    await stabilization.entered;
    harness.replaceAuthorityFork();
    stabilization.release();
    await expect(stale).rejects.toThrow('anchor changed');

    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      contextGraphId: '9',
      owner: MEMBER,
      participantAgents: [MEMBER],
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
    });
    expect(harness.evidence.indexInvalidations).toEqual([4]);
    expect(harness.evidence.indexRanges).toEqual([
      [7, 16], [17, 26], [27, 30],
      [7, 16], [17, 26], [27, 30],
    ]);
  });

  it.each([
    ['chain head', (harness: IndexedAuthorityHarness) => harness.holdHeadRead()],
    ['stabilization fence', (harness: IndexedAuthorityHarness) => harness.holdBlockRead(30)],
  ] as const)('keeps caller cancellation bound during the indexed %s read', async (
    _stage,
    hold,
  ) => {
    const harness = makeIndexedAuthorityAdapter();
    bindAbortableTipReader(harness);
    const gate = hold(harness);
    const abort = new AbortController();
    const pending = harness.adapter.getContextGraphAuthoritySnapshot(9n, {
      signal: abort.signal,
    });
    await gate.entered;
    abort.abort(new Error('snapshot caller left'));
    await expect(pending).rejects.toThrow('snapshot caller left');
    expect(harness.evidence.readOptions[0]?.signal).toBe(abort.signal);
    gate.release();
  });

  it('detaches one cancelled waiter without aborting its shared indexed page read', async () => {
    const harness = makeIndexedAuthorityAdapter();
    bindAbortableTipReader(harness);
    const gate = harness.holdIndexPageRead();
    const abort = new AbortController();
    const cancelled = harness.adapter.getContextGraphAuthoritySnapshot(9n, {
      signal: abort.signal,
    });
    await gate.entered;
    const survivor = harness.adapter.getContextGraphAuthoritySnapshot(9n);
    abort.abort(new Error('one waiter left'));
    await expect(cancelled).rejects.toThrow('one waiter left');
    gate.release();
    await expect(survivor).resolves.toMatchObject({ contextGraphId: '9' });
  });

  it('keeps production-context shared work alive when the initiating waiter cancels', async () => {
    const harness = makeIndexedAuthorityAdapter();
    bindProductionRpcTipReader(harness);
    const gate = harness.holdIndexPageRead();
    const firstAbort = new AbortController();
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    const first = reader.resolveFinalizedContextGraphAuthoritySnapshotByNameHash!(
      NAME_HASH,
      { signal: firstAbort.signal },
    );
    await gate.entered;
    const survivor = reader.resolveFinalizedContextGraphAuthoritySnapshotByNameHash!(NAME_HASH);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    // The survivor waits for the in-flight read to settle instead of racing it.
    expect(harness.evidence.headReads).toHaveLength(1);

    const sharedPageSignal = harness.evidence.indexPageSignals[0]!;
    firstAbort.abort(new Error('initiating snapshot waiter left'));
    await expect(first).rejects.toThrow('initiating snapshot waiter left');
    expect(sharedPageSignal.aborted).toBe(false);
    // It inherits nothing from the initiator's abort: it runs its OWN read,
    // which joins the physical page scan the index still owns.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(harness.evidence.headReads).toHaveLength(2);

    let idle = false;
    const drain = reader.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    gate.release();
    await expect(survivor).resolves.toMatchObject({ contextGraphId: '9' });
    await drain;
    expect(idle).toBe(true);
    expect(harness.evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);
  });

  it('tracks a caller-detached direct snapshot until clear cancels its owned page', async () => {
    const harness = makeIndexedAuthorityAdapter();
    bindProductionRpcTipReader(harness);
    const gate = harness.holdIndexPageRead();
    const abort = new AbortController();
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    const cancelled = harness.adapter.getContextGraphAuthoritySnapshot(9n, {
      signal: abort.signal,
    });
    await gate.entered;
    const ownedPageSignal = harness.evidence.indexPageSignals[0]!;

    abort.abort(new Error('only snapshot waiter left'));
    await expect(cancelled).rejects.toThrow('only snapshot waiter left');
    expect(ownedPageSignal.aborted).toBe(false);
    let idle = false;
    const drain = reader.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);

    harness.adapter.invalidatePublishPreflightCache();
    expect(ownedPageSignal.aborted).toBe(true);
    await drain;
    expect(idle).toBe(true);
    gate.release();
  });

  it('fails over when a provider cannot revalidate the durable authority anchor', async () => {
    const { adapter, provider, advanceAuthorityHead } = makeIndexedAuthorityAdapter();
    await adapter.getContextGraphAuthoritySnapshot(9n);
    advanceAuthorityHead();

    const attempts: string[] = [];
    const lagging: IndexedAuthorityProvider = {
      ...provider,
      getBlock: async (tag) => {
        if (tag === 30) return null;
        return provider.getBlock(tag);
      },
    };
    (adapter as any).readTipProvider = async (
      _label: string,
      read: (selected: IndexedAuthorityProvider) => Promise<unknown>,
      options: Readonly<{ isRetryable?: (error: unknown) => boolean }>,
    ) => {
      try {
        attempts.push('lagging');
        return await read(lagging);
      } catch (error) {
        expect(options.isRetryable?.(error)).toBe(true);
        attempts.push('healthy');
        return read(provider);
      }
    };

    await expect(adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      policyVersion: '4',
      sourceBlockNumber: '33',
    });
    expect(attempts).toEqual(['lagging', 'healthy']);
  });

  it('fails over when a provider cannot supply an intermediate page anchor', async () => {
    const { adapter, provider } = makeIndexedAuthorityAdapter();
    const attempts: string[] = [];
    const nonArchive: IndexedAuthorityProvider = {
      ...provider,
      getBlock: async (tag) => {
        if (tag === 16) return null;
        return provider.getBlock(tag);
      },
    };
    (adapter as any).readTipProvider = async (
      _label: string,
      read: (selected: IndexedAuthorityProvider) => Promise<unknown>,
      options: Readonly<{ isRetryable?: (error: unknown) => boolean }>,
    ) => {
      try {
        attempts.push('non-archive');
        return await read(nonArchive);
      } catch (error) {
        expect(options.isRetryable?.(error)).toBe(true);
        attempts.push('healthy');
        return read(provider);
      }
    };

    await expect(adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      contextGraphId: '9',
      policyVersion: '3',
    });
    expect(attempts).toEqual(['non-archive', 'healthy']);
  });

  it('materializes deactivation from the shared event index without a point read', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter({ deactivated: true });

    await expect(adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      contextGraphId: '9',
      active: false,
      owner: OWNER,
      participantAgents: [OWNER, MEMBER],
    });
    expect(evidence.staticCalls).toEqual([]);
  });
});

describe('RFC-64 indexed authority reads inside chain.indexTickMs', () => {
  const START_MS = 1_800_000_000_000;
  const T = 6_000;

  afterEach(() => { vi.useRealTimers(); });

  /** Give every block the chain time the production endpoint always reports. */
  function makeTimedAdapter(
    options: Parameters<typeof makeIndexedAuthorityAdapter>[0] = {},
  ): IndexedAuthorityHarness {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START_MS);
    const harness = makeIndexedAuthorityAdapter(options);
    const getBlock = harness.provider.getBlock;
    harness.provider.getBlock = async (tag) => {
      const block = await getBlock(tag);
      return block === null ? null : { ...block, timestamp: Math.floor(Date.now() / 1_000) - 2 };
    };
    return harness;
  }

  const rpcReads = ({ evidence }: IndexedAuthorityHarness): number => (
    evidence.headReads.length
    + evidence.blockReads.length
    + evidence.indexRanges.length
    + evidence.staticCalls.length
    + evidence.networkReads.length
  );

  it('answers the snapshot read and every index reader from one projection with zero RPC', async () => {
    const harness = makeTimedAdapter();
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    const served: string[] = [];
    const options = {
      onContextGraphAuthorityProjectionServed: ({ source }: { source: string }) => {
        served.push(source);
      },
    };

    const scanned = await harness.adapter.getContextGraphAuthoritySnapshot(9n, options);
    const reads = rpcReads(harness);
    expect(harness.evidence.headReads).toEqual([30]);

    vi.setSystemTime(START_MS + T - 1);
    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n, options))
      .resolves.toEqual(scanned);
    await expect(reader.readContextGraphAuthorityIndexSnapshots([authorityIndexId('9')], options))
      .resolves.toEqual(new Map([['9', scanned]]));
    await expect(reader.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')], options))
      .resolves.toEqual(new Map([['9', expect.stringMatching(/^0x[0-9a-f]{64}$/u)]]));
    await expect(reader.resolveFinalizedContextGraphIdByNameHash!(NAME_HASH, options))
      .resolves.toBe(9n);
    await expect(reader.resolveFinalizedContextGraphAuthoritySnapshotByNameHash!(NAME_HASH, options))
      .resolves.toEqual(scanned);

    expect(rpcReads(harness)).toBe(reads);
    expect(served).toEqual(['scan', 'cache', 'cache', 'cache', 'cache', 'cache']);
  });

  it('rejects an already-cancelled warm read without touching chain or index RPC', async () => {
    const harness = makeTimedAdapter();
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    const reads = rpcReads(harness);
    const reason = new Error('warm authority caller already left');
    const signal = AbortSignal.abort(reason);

    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n, { signal }))
      .rejects.toBe(reason);
    await expect(reader.readContextGraphAuthorityIndexRevisions(
      [authorityIndexId('9')],
      { signal },
    )).rejects.toBe(reason);
    expect(rpcReads(harness)).toBe(reads);
  });

  it('re-scans at T and only then observes authority the chain changed meanwhile', async () => {
    const harness = makeTimedAdapter();
    const before = await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    harness.advanceAuthorityHead();

    vi.setSystemTime(START_MS + T - 1);
    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toEqual(before);
    vi.setSystemTime(START_MS + T);
    const after = await harness.adapter.getContextGraphAuthoritySnapshot(9n);

    expect(after.policyVersion).not.toBe(before.policyVersion);
    expect(harness.evidence.headReads).toEqual([30, 35]);
  });

  it('serves a warm adapter projection as stale-cache only after a real refresh outage', async () => {
    const harness = makeTimedAdapter();
    const served: string[] = [];
    const options = {
      onContextGraphAuthorityProjectionServed: ({ source }: { source: string }) => {
        served.push(source);
      },
    };
    const warm = await harness.adapter.getContextGraphAuthoritySnapshot(9n, options);
    const reads = rpcReads(harness);
    (harness.adapter as any).readTipProvider = async () => {
      throw new RpcEndpointsExhaustedError('authority provider pool exhausted');
    };

    vi.setSystemTime(START_MS + T);
    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n, options))
      .resolves.toEqual(warm);
    expect(served).toEqual(['scan', 'stale-cache']);
    // The failing adapter refresh never reaches a provider read in this
    // fixture, so only the warm scan contributes evidence counters.
    expect(rpcReads(harness)).toBe(reads);
  });

  it('honours an operator-configured chain.indexTickMs', async () => {
    const harness = makeTimedAdapter({ indexTickMs: 1_000 });
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    vi.setSystemTime(START_MS + 999);
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    expect(harness.evidence.headReads).toEqual([30]);
    vi.setSystemTime(START_MS + 1_000);
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    expect(harness.evidence.headReads).toEqual([30, 30]);
  });

  it('builds the same snapshot and revision from the cache as from a fresh scan of that head', async () => {
    const cached = makeTimedAdapter();
    await cached.adapter.getContextGraphAuthoritySnapshot(9n);
    const reads = rpcReads(cached);
    const fromCache = await cached.adapter.getContextGraphAuthoritySnapshot(9n);
    const revisionFromCache = await cached.adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]);
    expect(rpcReads(cached)).toBe(reads);

    const fresh = makeIndexedAuthorityAdapter();
    const fromScan = await fresh.adapter.getContextGraphAuthoritySnapshot(9n);
    const revisionFromScan = await fresh.adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]);

    expect(JSON.stringify(fromCache)).toBe(JSON.stringify(fromScan));
    expect(Object.isFrozen(fromCache)).toBe(true);
    expect([...revisionFromCache]).toEqual([...revisionFromScan]);
  });

  it('keeps the core refresh loop scanning every pass and feeding only the durable snapshot', async () => {
    const harness = makeTimedAdapter();
    const snapshots = harness.adapter.contextGraphAuthorityIndexSnapshots!;
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    expect(harness.evidence.headReads).toEqual([30]);

    await snapshots.refresh();
    await snapshots.refresh();

    // Never answered from the projection cache, even well inside T.
    expect(harness.evidence.headReads).toEqual([30, 30, 30]);
    await expect(snapshots.exportSnapshot({
      scope: `${harness.adapter.deploymentId}:${GOVERNANCE}`,
      deploymentBlockNumber: 7, minThroughBlockNumber: 7, maxThroughBlockNumber: 30,
    })).resolves.toMatchObject({ checkpoint: { cursor: { throughBlockNumber: 30 } } });
  });

  it('drops the projection when the adapter invalidates its bound contracts', async () => {
    const harness = makeTimedAdapter();
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    harness.adapter.invalidatePublishPreflightCache();
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    expect(harness.evidence.headReads).toEqual([30, 30]);
  });

  it.each([
    ['addContextGraphParticipantAgent', 'confirmed'],
    ['removeContextGraphParticipantAgent', 'confirmed'],
    ['addContextGraphParticipantAgent', 'lost its receipt'],
  ] as const)('reads its own %s write back although T has not passed (%s)', async (method, outcome) => {
    const harness = makeTimedAdapter();
    const adapter = harness.adapter as any;
    adapter.contracts.contextGraphs = {};
    adapter.sendContractTransaction = async () => {
      if (outcome !== 'confirmed') throw new Error('receipt lookup failed');
      return { hash: `0x${'ab'.repeat(32)}`, blockNumber: 31, index: 0, status: 1 };
    };
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);

    const write = adapter[method](9n, MEMBER);
    await (outcome === 'confirmed'
      ? expect(write).resolves.toMatchObject({ success: true })
      : expect(write).rejects.toThrow('receipt lookup failed'));
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);

    expect(harness.evidence.headReads).toEqual([30, 30]);
  });

  it.each([
    ['duplicate', NAME_HASH, 'ambiguous'],
    ['unique', LATE_NAME_HASH, '11'],
  ] as const)(
    'invalidates a warm projection after a %s-name Context Graph create',
    async (_case, createdNameHash, expected) => {
      const harness = makeTimedAdapter({ lateContextGraphNameHash: createdNameHash });
      const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
      await expect(reader.resolveFinalizedContextGraphIdByNameHash!(NAME_HASH)).resolves.toBe(9n);

      const adapter = harness.adapter as any;
      adapter.contracts.contextGraphs = {};
      adapter.contracts.contextGraphStorage.interface = {
        parseLog: () => ({
          name: 'ContextGraphCreated',
          args: { contextGraphId: 11n },
        }),
      };
      adapter.sendContractTransaction = async () => {
        harness.advanceAuthorityHead();
        return {
          hash: `0x${'ab'.repeat(32)}`,
          blockNumber: 31,
          index: 0,
          status: 1,
          logs: [{ topics: [], data: '0x' }],
        };
      };

      await expect(harness.adapter.createOnChainContextGraph({
        accessPolicy: 1,
        publishPolicy: 0,
        nameHash: createdNameHash,
      })).resolves.toMatchObject({ success: true, contextGraphId: 11n });

      const read = reader.resolveFinalizedContextGraphIdByNameHash!(createdNameHash);
      if (expected === 'ambiguous') {
        await expect(read).rejects.toThrow('ambiguous across 2 finalized Context Graphs');
      } else {
        await expect(read).resolves.toBe(11n);
      }
      expect(harness.evidence.headReads).toEqual([30, 35]);
      expect(harness.evidence.indexRanges.at(-1)).toEqual([31, 35]);
    },
  );

  it('invalidates a warm projection when a Context Graph create loses its receipt', async () => {
    const harness = makeTimedAdapter();
    const adapter = harness.adapter as any;
    adapter.contracts.contextGraphs = {};
    adapter.sendContractTransaction = async () => { throw new Error('receipt lookup failed'); };
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);

    await expect(harness.adapter.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 0 }))
      .rejects.toThrow('receipt lookup failed');
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);

    expect(harness.evidence.headReads).toEqual([30, 30]);
  });

  it('rejects when the requested and scanned ContextGraphStorage addresses diverge', async () => {
    const harness = makeTimedAdapter();
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    (harness.adapter as any).contracts.contextGraphStorage.getAddress = async () => MEMBER;

    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n)).rejects.toThrow(
      'Context Graph authority contract changed during refresh',
    );
    await expect(reader.readContextGraphAuthorityIndexRevisions([authorityIndexId('9')]))
      .rejects.toThrow('Context Graph authority contract changed during refresh');

    expect(harness.evidence.headReads).toEqual([30, 30, 30]);
  });

  it('reports an id the projection does not contain as absent only after a fresh scan', async () => {
    const harness = makeTimedAdapter();
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    await expect(harness.adapter.getContextGraphAuthoritySnapshot(404n))
      .rejects.toThrow('Context Graph 404 has no finalized creation event');
    expect(harness.evidence.headReads).toEqual([30, 30]);
    await expect(harness.adapter.contextGraphAuthorityIndexRevisionReader!
      .readContextGraphAuthorityIndexSnapshots([authorityIndexId('404')]))
      .resolves.toEqual(new Map());
    expect(harness.evidence.headReads).toEqual([30, 30, 30]);
  });

  it('reports name hashes absent from a warm projection only after a fresh scan', async () => {
    const harness = makeTimedAdapter();
    const reader = harness.adapter.contextGraphAuthorityIndexRevisionReader!;
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);

    await expect(reader.resolveFinalizedContextGraphIdByNameHash!(LATE_NAME_HASH))
      .resolves.toBeNull();
    expect(harness.evidence.headReads).toEqual([30, 30]);

    await expect(reader.resolveFinalizedContextGraphAuthoritySnapshotByNameHash!(LATE_NAME_HASH))
      .resolves.toBeNull();
    expect(harness.evidence.headReads).toEqual([30, 30, 30]);
  });

  it('rejects an invalid chain.indexTickMs at construction', () => {
    for (const indexTickMs of [0, 1.5, -6_000]) {
      expect(() => new EVMChainAdapter({
        rpcUrl: 'http://127.0.0.1:1',
        hubAddress: GOVERNANCE,
        privateKey: `0x${'11'.repeat(32)}`,
        allowNoAdminSigner: true,
        chainId: 'evm:31337',
        localContextGraphAuthorityIndexStore: new MemoryAuthorityIndexStore(),
        indexTickMs,
      })).toThrow('chain.indexTickMs must be a positive integer');
    }
  });
});
