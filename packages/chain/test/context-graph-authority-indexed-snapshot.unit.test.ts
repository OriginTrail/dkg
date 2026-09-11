// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import type { ContextGraphAuthorityIndexId } from '../src/chain-adapter.js';
import { ContextGraphAuthorityIndexRetryableError } from
  '../src/context-graph-authority-index.js';
import {
  createAbortableTipReader,
  MemoryAuthorityIndexStore,
} from './helpers/context-graph-authority-index.js';
import {
  AUTHORITY,
  createAuthorityScenario,
  GOVERNANCE,
  MEMBER,
  OWNER,
} from './helpers/context-graph-authority-scenario.js';

const authorityIndexId = (value: string): ContextGraphAuthorityIndexId => (
  value as ContextGraphAuthorityIndexId
);

interface IndexedAuthorityEvidence {
  readonly filters: Array<readonly [string, ...unknown[]]>;
  readonly staticCalls: Array<readonly [bigint, { blockTag: number }]>;
  readonly readOptions: Array<Readonly<{
    policy?: string;
    signal?: AbortSignal;
    isRetryable?: (error: unknown) => boolean;
  }>>;
  readonly indexRanges: Array<readonly [number, number]>;
  readonly indexTopicSets: string[][];
  readonly indexAddresses: string[];
  readonly indexInvalidations: number[];
}

interface IndexedAuthorityProvider {
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
  holdIndexPageRead(): Readonly<{ entered: Promise<void>; release(): void }>;
}

function makeIndexedAuthorityAdapter(
  options: Readonly<{ deactivated?: boolean }> = {},
): IndexedAuthorityHarness {
  const scenario = createAuthorityScenario(options);
  const authorityIndexStore = new MemoryAuthorityIndexStore();
  const adapter: any = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: GOVERNANCE,
    privateKey: `0x${'11'.repeat(32)}`,
    allowNoAdminSigner: true,
    chainId: 'evm:31337',
    localContextGraphAuthorityIndexStore: authorityIndexStore,
  });
  adapter.initialized = true;
  adapter.init = async () => {};
  adapter.cgRegistryScanPageSize = 10;

  const evidence: IndexedAuthorityEvidence = {
    filters: [],
    staticCalls: [],
    readOptions: [],
    indexRanges: [],
    indexTopicSets: [],
    indexAddresses: [],
    indexInvalidations: authorityIndexStore.invalidations,
  };
  let indexPageReadGate: Readonly<{
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  }> | undefined;

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
    getBlock: (tag) => scenario.getBlock(tag),
    getNetwork: async () => ({ chainId: 31337n }),
    getLogs: async (filter) => {
      expect(filter.address).toBe(GOVERNANCE);
      evidence.indexAddresses.push(filter.address);
      evidence.indexRanges.push([filter.fromBlock, filter.toBlock]);
      evidence.indexTopicSets.push(filter.topics[0] ?? []);
      const gate = indexPageReadGate;
      if (gate !== undefined) {
        indexPageReadGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return scenario.renderParsedLogs(filter.fromBlock, filter.toBlock);
    },
  };

  adapter.contracts = {
    contextGraphStorage: { connect: () => contract },
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

describe('RFC-64 indexed Context Graph authority snapshots', () => {
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

  it('projects stable per-CG revisions from one shared index advance', async () => {
    const { adapter, evidence, advanceAuthorityHead } = makeIndexedAuthorityAdapter();
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    const initial = await reader.readContextGraphAuthorityIndexRevisions(
      [authorityIndexId('9'), authorityIndexId('9'), authorityIndexId('10')],
    );
    expect(initial).toEqual(new Map([[
      '9',
      expect.stringMatching(/^0x[0-9a-f]{64}$/u),
    ]]));
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);

    const unchanged = await reader.readContextGraphAuthorityIndexRevisions([
      authorityIndexId('9'),
    ]);
    expect(unchanged).toEqual(initial);
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

  it('rejects invalid revision target sets before reading the shared index', async () => {
    const { adapter, evidence } = makeIndexedAuthorityAdapter();
    const reader = adapter.contextGraphAuthorityIndexRevisionReader!;

    await expect(reader.readContextGraphAuthorityIndexRevisions([])).resolves.toEqual(new Map());
    for (const invalidId of ['0', (ethers.MaxUint256 + 1n).toString(10)]) {
      await expect(reader.readContextGraphAuthorityIndexRevisions([
        invalidId as ContextGraphAuthorityIndexId,
      ]))
        .rejects.toThrow('target id is invalid');
    }
    await expect(reader.readContextGraphAuthorityIndexRevisions(
      Array.from(
        { length: 4_097 },
        (_, index) => authorityIndexId(String(index + 1)),
      ),
    )).rejects.toThrow('target set is invalid');
    expect(evidence.indexRanges).toEqual([]);
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

  it.each([
    ['finalized head', (harness: IndexedAuthorityHarness) => harness.holdBlockRead('finalized')],
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
      policy: 'wideLogScan',
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
      policy: 'wideLogScan',
      signal: abort.signal,
    });
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
    ['finalized head', (harness: IndexedAuthorityHarness) => harness.holdBlockRead('finalized')],
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
