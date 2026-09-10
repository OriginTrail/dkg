// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  createAbortableTipReader,
  MemoryAuthorityIndexStore,
} from './helpers/context-graph-authority-index.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const MEMBER = '0x2222222222222222222222222222222222222222';
const AUTHORITY = '0x3333333333333333333333333333333333333333';
const GOVERNANCE = '0x4444444444444444444444444444444444444444';
const SECOND_MEMBER = '0x5555555555555555555555555555555555555555';
const SECOND_AUTHORITY = '0x6666666666666666666666666666666666666666';
const FINALIZED_HASH = `0x${'55'.repeat(32)}`;
const NEXT_FINALIZED_HASH = `0x${'56'.repeat(32)}`;
const REPLACEMENT_FINALIZED_HASH = `0x${'cc'.repeat(32)}`;
const CREATION_HASH = `0x${'66'.repeat(32)}`;
const POLICY_HASH = `0x${'77'.repeat(32)}`;
const NEXT_POLICY_HASH = `0x${'78'.repeat(32)}`;
const NAME_HASH = `0x${'88'.repeat(32)}`;

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
  let finalizedNumber = 30;
  let finalizedHash = FINALIZED_HASH;
  let cachedAnchorReplaced = false;
  let replacementAuthorityFork = false;
  let blockReadGate: Readonly<{
    tag: string | number;
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  }> | undefined;
  let indexPageReadGate: Readonly<{
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  }> | undefined;

  const namedArgs = (values: readonly unknown[], names: Record<string, unknown>) => (
    Object.assign([...values], names)
  );
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
        return Object.assign(
          [OWNER, [MEMBER, OWNER], 0n, !options.deactivated, 0n, 1n, 0n, AUTHORITY, 7n],
          {
            owner: OWNER,
            participantAgents: [MEMBER, OWNER],
            active: !options.deactivated,
            accessPolicy: 1n,
            publishPolicy: 0n,
            publishAuthority: AUTHORITY,
            publishAuthorityAccountId: 7n,
          },
        );
      },
    },
    getAddress: async () => GOVERNANCE,
  };

  const provider: IndexedAuthorityProvider = {
    getBlock: async (tag) => {
      const gate = blockReadGate;
      if (gate?.tag === tag) {
        blockReadGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      if (tag === 'finalized') return { number: finalizedNumber, hash: finalizedHash };
      const historicalHash = tag === 30 && cachedAnchorReplaced
        ? REPLACEMENT_FINALIZED_HASH
        : tag === 30
          ? FINALIZED_HASH
          : finalizedHash;
      return { number: Number(tag), hash: historicalHash };
    },
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
      const forkOwner = replacementAuthorityFork ? MEMBER : SECOND_MEMBER;
      const forkParticipants = replacementAuthorityFork
        ? [MEMBER]
        : [MEMBER, SECOND_MEMBER];
      return [
        {
          blockNumber: 10,
          blockHash: CREATION_HASH,
          index: 1,
          parsed: {
            name: 'ContextGraphCreated',
            args: namedArgs([
              9n,
              forkOwner,
              NAME_HASH,
              forkParticipants,
              0n,
              1n,
              0n,
              AUTHORITY,
              7n,
            ], {
              contextGraphId: 9n,
              owner: forkOwner,
              nameHash: NAME_HASH,
              participantAgents: forkParticipants,
              accessPolicy: 1n,
              publishPolicy: 0n,
              publishAuthority: AUTHORITY,
              publishAuthorityAccountId: 7n,
            }),
          },
        },
        {
          blockNumber: 10,
          blockHash: CREATION_HASH,
          index: 0,
          parsed: {
            name: 'Transfer',
            args: namedArgs([ethers.ZeroAddress, forkOwner, 9n], {
              from: ethers.ZeroAddress,
              to: forkOwner,
              tokenId: 9n,
            }),
          },
        },
        {
          blockNumber: 15,
          blockHash: `0x${'99'.repeat(32)}`,
          index: 0,
          parsed: {
            name: 'Transfer',
            args: namedArgs([SECOND_MEMBER, OWNER, 9n], {
              from: SECOND_MEMBER,
              to: OWNER,
              tokenId: 9n,
            }),
          },
        },
        {
          blockNumber: 20,
          blockHash: POLICY_HASH,
          index: 0,
          parsed: {
            name: 'PublishPolicyUpdated',
            args: namedArgs([9n, 0n, SECOND_AUTHORITY, 9n], {
              contextGraphId: 9n,
              publishPolicy: 0n,
              publishAuthority: SECOND_AUTHORITY,
              publishAuthorityAccountId: 9n,
            }),
          },
        },
        {
          blockNumber: 21,
          blockHash: POLICY_HASH,
          index: 0,
          parsed: {
            name: 'PublishAuthorityUpdated',
            args: namedArgs([9n, AUTHORITY, 7n], {
              contextGraphId: 9n,
              newAuthority: AUTHORITY,
              newAuthorityAccountId: 7n,
            }),
          },
        },
        ...[
          ['AgentParticipantAdded', 22, `0x${'aa'.repeat(32)}`, OWNER],
          ['AgentParticipantRemoved', 23, `0x${'bb'.repeat(32)}`, SECOND_MEMBER],
        ].map(([name, blockNumber, hash, agent]) => ({
          blockNumber,
          blockHash: hash,
          index: 0,
          parsed: {
            name,
            args: namedArgs([9n, agent], { contextGraphId: 9n, agent }),
          },
        })),
        ...(options.deactivated ? [{
          blockNumber: 24,
          blockHash: `0x${'bc'.repeat(32)}`,
          index: 0,
          parsed: {
            name: 'ContextGraphDeactivated',
            args: namedArgs([9n], { contextGraphId: 9n }),
          },
        }] : []),
        {
          blockNumber: 33,
          blockHash: NEXT_POLICY_HASH,
          index: 0,
          parsed: {
            name: 'PublishPolicyUpdated',
            args: namedArgs([9n, 1n, ethers.ZeroAddress, 0n], {
              contextGraphId: 9n,
              publishPolicy: 1n,
              publishAuthority: ethers.ZeroAddress,
              publishAuthorityAccountId: 0n,
            }),
          },
        },
      ].filter((entry) => {
        if (
          replacementAuthorityFork
          && entry.parsed.name !== 'ContextGraphCreated'
          && !(entry.parsed.name === 'Transfer' && entry.blockNumber === 10)
        ) return false;
        return Number(entry.blockNumber) >= filter.fromBlock
          && Number(entry.blockNumber) <= filter.toBlock;
      });
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
    advanceAuthorityHead: () => {
      finalizedNumber = 35;
      finalizedHash = NEXT_FINALIZED_HASH;
    },
    replaceAuthorityFork: () => {
      finalizedHash = REPLACEMENT_FINALIZED_HASH;
      cachedAnchorReplaced = true;
      replacementAuthorityFork = true;
    },
    holdBlockRead: (tag) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      blockReadGate = { tag, entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
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
