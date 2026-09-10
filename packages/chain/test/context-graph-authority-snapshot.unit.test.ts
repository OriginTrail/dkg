// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import type { ContextGraphAuthoritySnapshot } from '../src/chain-adapter.js';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const MEMBER = '0x2222222222222222222222222222222222222222';
const AUTHORITY = '0x3333333333333333333333333333333333333333';
const GOVERNANCE = '0x4444444444444444444444444444444444444444';
const SECOND_MEMBER = '0x5555555555555555555555555555555555555555';
const SECOND_AUTHORITY = '0x6666666666666666666666666666666666666666';
const FINALIZED_HASH = `0x${'55'.repeat(32)}`;
const NEXT_FINALIZED_HASH = `0x${'56'.repeat(32)}`;
const CREATION_HASH = `0x${'66'.repeat(32)}`;
const POLICY_HASH = `0x${'77'.repeat(32)}`;
const NEXT_POLICY_HASH = `0x${'78'.repeat(32)}`;
const NAME_HASH = `0x${'88'.repeat(32)}`;

function event(
  blockNumber: number,
  index: number,
  blockHash: string,
  args: readonly unknown[] = [],
) {
  return { blockNumber, index, blockHash, args };
}

interface AuthorityEvidence {
  readonly filters: Array<readonly [string, ...unknown[]]>;
  readonly ranges: Array<readonly [number, number]>;
  readonly staticCalls: Array<readonly [bigint, { blockTag: number }]>;
  readonly deploymentReads: Array<readonly [string, string, string]>;
  readonly readOptions: Array<Readonly<{ policy?: string; signal?: AbortSignal }>>;
  readonly indexRanges: Array<readonly [number, number]>;
  readonly indexTopicSets: string[][];
  readonly indexAddresses: string[];
}

interface EvmAuthorityHarness {
  readonly adapter: EVMChainAdapter;
  readonly evidence: AuthorityEvidence;
  readonly provider: Readonly<Record<string, unknown>>;
  advanceAuthorityHead(): void;
  replaceCachedAnchor(): void;
  replaceFinalizedHead(): void;
  holdCurrentStateRead(): Readonly<{ entered: Promise<void>; release(): void }>;
  holdBlockRead(tag: string | number): Readonly<{ entered: Promise<void>; release(): void }>;
  holdIndexPageRead(): Readonly<{ entered: Promise<void>; release(): void }>;
  setPublishAuthorityAccountId(value: unknown): void;
  rotateContextGraphStorage(): void;
}

function makeEvmAuthorityAdapter(
  options: { reorg?: boolean; providerRangeLimit?: number; sharedIndex?: boolean } = {},
): EvmAuthorityHarness {
  let authorityIndexRecord: Readonly<{ token: number; value: unknown | null }> | undefined;
  const authorityIndexStore = {
    load: async () => authorityIndexRecord,
    compareAndSwap: async (
      _scope: string,
      expectedToken: number | undefined,
      value: unknown,
    ) => {
      if (authorityIndexRecord?.token !== expectedToken) return undefined;
      const nextToken = expectedToken === undefined ? 1 : expectedToken + 1;
      authorityIndexRecord = { token: nextToken, value };
      return nextToken;
    },
    invalidate: async (_scope: string, expectedToken: number) => {
      if (authorityIndexRecord?.token !== expectedToken) return undefined;
      const nextToken = expectedToken + 1;
      authorityIndexRecord = { token: nextToken, value: null };
      return nextToken;
    },
  };
  const adapter: any = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: GOVERNANCE,
    privateKey: `0x${'11'.repeat(32)}`,
    allowNoAdminSigner: true,
    chainId: 'evm:31337',
    ...(options.sharedIndex ? { localContextGraphAuthorityIndexStore: authorityIndexStore } : {}),
  });
  adapter.initialized = true;
  adapter.init = async () => {};
  adapter.cgRegistryScanPageSize = 10;
  const evidence: AuthorityEvidence = {
    filters: [] as Array<readonly [string, ...unknown[]]>,
    ranges: [] as Array<readonly [number, number]>,
    staticCalls: [] as Array<readonly [bigint, { blockTag: number }]>,
    deploymentReads: [] as Array<readonly [string, string, string]>,
    readOptions: [],
    indexRanges: [],
    indexTopicSets: [],
    indexAddresses: [],
  };

  let finalizedNumber = 30;
  let finalizedHash = FINALIZED_HASH;
  let cachedAnchorReplaced = false;
  let currentReadGate: PromiseWithResolvers<void> | undefined;
  let blockReadGate: Readonly<{
    tag: string | number;
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  }> | undefined;
  let indexPageReadGate: Readonly<{
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  }> | undefined;
  const logs: Record<string, ReturnType<typeof event>[]> = {
    ContextGraphCreated: [event(10, 1, CREATION_HASH, [9n, OWNER, NAME_HASH])],
    Transfer: [
      event(10, 0, CREATION_HASH, [ethers.ZeroAddress, OWNER, 9n]),
      event(15, 0, `0x${'99'.repeat(32)}`, [SECOND_MEMBER, OWNER, 9n]),
    ],
    PublishPolicyUpdated: [event(20, 0, POLICY_HASH)],
    PublishAuthorityUpdated: [event(21, 0, POLICY_HASH)],
    AgentParticipantAdded: [event(22, 0, `0x${'aa'.repeat(32)}`)],
    AgentParticipantRemoved: [event(23, 0, `0x${'bb'.repeat(32)}`)],
  };
  const current = Object.assign(
    [OWNER, [MEMBER, OWNER], 0n, true, 0n, 1n, 0n, AUTHORITY, 7n],
    {
      owner: OWNER,
      participantAgents: [MEMBER, OWNER],
      active: true,
      accessPolicy: 1n,
      publishPolicy: 0n,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: 7n,
    },
  );
  const contract = {
    interface: {
      getEvent: (name: string) => ({ topicHash: `topic:${name}` }),
      parseLog: (log: { parsed: unknown }) => log.parsed,
    },
    filters: Object.fromEntries(Object.keys(logs).map((name) => [
      name,
      (...args: readonly unknown[]) => {
        evidence.filters.push([name, ...args]);
        const expectedArgs = name === 'Transfer'
          ? [null, null, 9n]
          : [9n];
        expect(args).toEqual(expectedArgs);
        return { name, args };
      },
    ])),
    queryFilter: async (filter: { name: string }, fromBlock: number, toBlock: number) => {
      evidence.ranges.push([fromBlock, toBlock]);
      if (
        options.providerRangeLimit !== undefined
        && toBlock - fromBlock + 1 > options.providerRangeLimit
      ) {
        throw {
          cause: {
            info: {
              error: {
                message: `eth_getLogs is limited to ${options.providerRangeLimit} blocks`,
              },
            },
          },
        };
      }
      return (logs[filter.name] ?? []).filter(
        (entry) => entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock,
      );
    },
    getContextGraph: {
      staticCall: async (contextGraphId: bigint, readOptions: { blockTag: number }) => {
        evidence.staticCalls.push([contextGraphId, readOptions]);
        expect(contextGraphId).toBe(9n);
        expect(readOptions).toEqual({ blockTag: finalizedNumber });
        const gate = currentReadGate;
        if (gate !== undefined) {
          currentReadGate = undefined;
          gate.resolve();
          await gate.promise;
        }
        return current;
      },
    },
    getAddress: async () => GOVERNANCE,
  };
  const provider = {
    getBlock: async (tag: string | number) => {
      const gate = blockReadGate;
      if (gate?.tag === tag) {
        blockReadGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      if (tag === 'finalized') return { number: finalizedNumber, hash: finalizedHash };
      const historicalHash = tag === 30 && cachedAnchorReplaced
        ? `0x${'cc'.repeat(32)}`
        : tag === 30
          ? FINALIZED_HASH
          : finalizedHash;
      return {
        number: Number(tag),
        hash: options.reorg && tag === finalizedNumber
          ? `0x${'cc'.repeat(32)}`
          : historicalHash,
      };
    },
    getNetwork: async () => ({ chainId: 31337n }),
    getLogs: async (filter: {
      address: string;
      fromBlock: number;
      toBlock: number;
      topics: string[][];
    }) => {
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
      const namedArgs = (values: readonly unknown[], names: Record<string, unknown>) => (
        Object.assign([...values], names)
      );
      return [
        {
          blockNumber: 10,
          blockHash: CREATION_HASH,
          index: 1,
          parsed: {
            name: 'ContextGraphCreated',
            args: namedArgs([9n, OWNER, NAME_HASH], {
              contextGraphId: 9n, owner: OWNER, nameHash: NAME_HASH,
            }),
          },
        },
        {
          blockNumber: 10,
          blockHash: CREATION_HASH,
          index: 0,
          parsed: {
            name: 'Transfer',
            args: namedArgs([ethers.ZeroAddress, OWNER, 9n], {
              from: ethers.ZeroAddress, to: OWNER, tokenId: 9n,
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
              from: SECOND_MEMBER, to: OWNER, tokenId: 9n,
            }),
          },
        },
        ...[
          ['PublishPolicyUpdated', 20, 0, POLICY_HASH],
          ['PublishAuthorityUpdated', 21, 0, POLICY_HASH],
          ['AgentParticipantAdded', 22, 0, `0x${'aa'.repeat(32)}`],
          ['AgentParticipantRemoved', 23, 0, `0x${'bb'.repeat(32)}`],
          ['PublishPolicyUpdated', 33, 0, NEXT_POLICY_HASH],
        ].map(([name, blockNumber, index, hash]) => ({
          blockNumber,
          blockHash: hash,
          index,
          parsed: {
            name,
            args: namedArgs([9n], { contextGraphId: 9n }),
          },
        })),
      ].filter((entry) => (
        Number(entry.blockNumber) >= filter.fromBlock
        && Number(entry.blockNumber) <= filter.toBlock
      ));
    },
  };
  adapter.contracts = {
    contextGraphStorage: { connect: () => contract },
  };
  adapter.readTipProvider = async (
    _label: string,
    read: (selectedProvider: typeof provider) => Promise<unknown>,
    readOptions: Readonly<{ policy?: string }>,
  ) => {
    evidence.readOptions.push(readOptions);
    return read(provider);
  };
  adapter.resolveContractDeployBlock = async (
    address: string,
    operation: string,
    label: string,
  ) => {
    evidence.deploymentReads.push([address, operation, label]);
    return { fromBlock: 7, head: 30, scanProviders: [] };
  };
  const advanceAuthorityHead = () => {
    finalizedNumber = 35;
    finalizedHash = NEXT_FINALIZED_HASH;
    logs.PublishPolicyUpdated.push(event(33, 0, NEXT_POLICY_HASH));
    current.publishPolicy = 1n;
    current[6] = 1n;
  };
  const replaceCachedAnchor = () => {
    cachedAnchorReplaced = true;
  };
  return {
    adapter: adapter as EVMChainAdapter,
    evidence,
    provider,
    advanceAuthorityHead,
    replaceCachedAnchor,
    replaceFinalizedHead: () => {
      finalizedHash = `0x${'cc'.repeat(32)}`;
      cachedAnchorReplaced = true;
    },
    holdCurrentStateRead: () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      currentReadGate = {
        promise: release.promise,
        resolve: entered.resolve,
        reject: release.reject,
      };
      return { entered: entered.promise, release: release.resolve };
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
    setPublishAuthorityAccountId: (value) => {
      current.publishAuthorityAccountId = value;
      current[8] = value;
    },
    rotateContextGraphStorage: () => adapter.applyHubRotationEventName('ContextGraphStorage'),
  };
}

describe('RFC-64 Context Graph authority snapshots', () => {
  it('uses one combined contract-wide log request per page when the durable index is wired', async () => {
    const { adapter, evidence } = makeEvmAuthorityAdapter({ sharedIndex: true });

    const snapshot = await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(snapshot).toMatchObject({
      contextGraphId: '9',
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
      'topic:Transfer',
      'topic:PublishPolicyUpdated',
      'topic:PublishAuthorityUpdated',
      'topic:AgentParticipantAdded',
      'topic:AgentParticipantRemoved',
    ]));

    await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(evidence.indexRanges).toHaveLength(3);
  });

  it.each([
    ['finalized head', (harness: EvmAuthorityHarness) => harness.holdBlockRead('finalized')],
    ['current state', (harness: EvmAuthorityHarness) => harness.holdCurrentStateRead()],
    ['stabilization fence', (harness: EvmAuthorityHarness) => harness.holdBlockRead(30)],
  ] as const)('keeps caller cancellation bound during the indexed %s read', async (
    _stage,
    hold,
  ) => {
    const harness = makeEvmAuthorityAdapter({ sharedIndex: true });
    const adapter = harness.adapter as any;
    adapter.readTipProvider = async (
      _label: string,
      read: (provider: EvmAuthorityHarness['provider']) => Promise<unknown>,
      options: Readonly<{ signal?: AbortSignal }>,
    ) => {
      harness.evidence.readOptions.push(options);
      const pending = read(harness.provider);
      if (options.signal === undefined) return pending;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(options.signal!.reason);
        options.signal!.addEventListener('abort', onAbort, { once: true });
        void pending.then(resolve, reject).finally(() => {
          options.signal!.removeEventListener('abort', onAbort);
        });
      });
    };
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
    const harness = makeEvmAuthorityAdapter({ sharedIndex: true });
    const adapter = harness.adapter as any;
    adapter.readTipProvider = async (
      _label: string,
      read: (provider: EvmAuthorityHarness['provider']) => Promise<unknown>,
      options: Readonly<{ signal?: AbortSignal }>,
    ) => {
      const pending = read(harness.provider);
      if (options.signal === undefined) return pending;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(options.signal!.reason);
        options.signal!.addEventListener('abort', onAbort, { once: true });
        void pending.then(resolve, reject).finally(() => {
          options.signal!.removeEventListener('abort', onAbort);
        });
      });
    };
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
    const { adapter, provider, advanceAuthorityHead } = makeEvmAuthorityAdapter({
      sharedIndex: true,
    });
    await adapter.getContextGraphAuthoritySnapshot(9n);
    advanceAuthorityHead();

    const attempts: string[] = [];
    const lagging = {
      ...provider,
      getBlock: async (tag: string | number) => {
        if (tag === 30) return null;
        return (provider.getBlock as (block: string | number) => Promise<unknown>)(tag);
      },
    };
    (adapter as any).readTipProvider = async (
      _label: string,
      read: (selected: typeof lagging) => Promise<unknown>,
      options: Readonly<{ isRetryable?: (error: unknown) => boolean }>,
    ) => {
      try {
        attempts.push('lagging');
        return await read(lagging);
      } catch (error) {
        expect(options.isRetryable?.(error)).toBe(true);
        attempts.push('healthy');
        return read(provider as typeof lagging);
      }
    };

    await expect(adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      policyVersion: '4',
      sourceBlockNumber: '33',
    });
    expect(attempts).toEqual(['lagging', 'healthy']);
  });

  it('reads one stable finalized EVM generation and derives monotonic epochs', async () => {
    const { adapter, evidence, advanceAuthorityHead } = makeEvmAuthorityAdapter();
    const snapshot = await adapter.getContextGraphAuthoritySnapshot(9n);

    expect(snapshot).toEqual({
      chainId: '31337',
      governanceContract: GOVERNANCE,
      contextGraphId: '9',
      owner: OWNER,
      active: true,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: '7',
      participantAgents: [OWNER, MEMBER],
      nameHash: NAME_HASH,
      ownershipEra: '1',
      policyVersion: '3',
      rosterVersion: '3',
      sourceBlockNumber: '21',
      sourceBlockHash: POLICY_HASH,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.participantAgents)).toBe(true);
    expect(evidence.staticCalls).toEqual([[9n, { blockTag: 30 }]]);
    expect(evidence.deploymentReads).toEqual([[
      GOVERNANCE,
      'getContextGraphAuthoritySnapshot',
      'ContextGraphStorage',
    ]]);
    expect(evidence.readOptions[0]).toMatchObject({ policy: 'wideLogScan' });
    expect(evidence.filters).toEqual([
      ['ContextGraphCreated', 9n],
      ['Transfer', null, null, 9n],
      ['PublishPolicyUpdated', 9n],
      ['PublishAuthorityUpdated', 9n],
      ['AgentParticipantAdded', 9n],
      ['AgentParticipantRemoved', 9n],
    ]);
    expect(evidence.ranges).toHaveLength(18);
    expect(evidence.ranges).toEqual(expect.arrayContaining([
      [7, 16],
      [17, 26],
      [27, 30],
    ]));

    const repeated = await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(repeated).toEqual(snapshot);
    expect(evidence.deploymentReads).toHaveLength(1);
    expect(evidence.ranges).toHaveLength(18);
    expect(evidence.filters).toHaveLength(6);
    expect(evidence.staticCalls).toEqual([
      [9n, { blockTag: 30 }],
      [9n, { blockTag: 30 }],
    ]);

    advanceAuthorityHead();
    const advanced = await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(advanced).toMatchObject({
      publishPolicy: 1,
      ownershipEra: '1',
      policyVersion: '4',
      rosterVersion: '3',
      sourceBlockNumber: '33',
      sourceBlockHash: NEXT_POLICY_HASH,
    });
    // Five event types are read once over only the unseen suffix. Creation is
    // immutable and is never scanned again.
    expect(evidence.ranges.slice(18)).toEqual(Array(5).fill([31, 35]));
    expect(evidence.deploymentReads).toHaveLength(1);
  });

  it('splits provider-capped ranges through the real adapter queryFilter boundary', async () => {
    const { adapter, evidence } = makeEvmAuthorityAdapter({ providerRangeLimit: 10 });
    (adapter as any).cgRegistryScanPageSize = 30;

    const snapshot = await adapter.getContextGraphAuthoritySnapshot(9n);

    expect(snapshot).toMatchObject({
      contextGraphId: '9',
      owner: OWNER,
      publishPolicy: 0,
      ownershipEra: '1',
      policyVersion: '3',
      rosterVersion: '3',
    });
    expect(evidence.ranges).toEqual(expect.arrayContaining([
      [7, 30],
      [7, 18],
      [7, 12],
      [13, 18],
      [19, 30],
      [19, 24],
      [25, 30],
    ]));
  });

  it('rejects a finalized anchor that changes while the generation is read', async () => {
    await expect(makeEvmAuthorityAdapter({ reorg: true }).adapter
      .getContextGraphAuthoritySnapshot(9n))
      .rejects.toThrow('anchor changed');
  });

  it('rechecks the anchor after a delayed concurrent current-state read', async () => {
    const harness = makeEvmAuthorityAdapter();
    const gate = harness.holdCurrentStateRead();
    const pending = harness.adapter.getContextGraphAuthoritySnapshot(9n);
    await gate.entered;
    // History can finish while the static call is held. Replacing the anchor
    // here must still invalidate the combined snapshot and its watermark.
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.replaceFinalizedHead();
    gate.release();
    await expect(pending).rejects.toThrow('anchor changed');
  });

  it('lets adapter failover leave a stalled same-head history reader behind', async () => {
    const { adapter: typedAdapter } = makeEvmAuthorityAdapter();
    const adapter = typedAdapter as any;
    const baseContract = adapter.contracts.contextGraphStorage.connect();
    const historyEntered = Promise.withResolvers<void>();
    const stalledHistory = new Promise<never>(() => {});
    const makeProvider = () => ({
      getBlock: async (tag: string | number) => ({
        number: tag === 'finalized' ? 30 : Number(tag),
        hash: FINALIZED_HASH,
      }),
      getNetwork: async () => ({ chainId: 31337n }),
    });
    const stalledProvider = makeProvider();
    const healthyProvider = makeProvider();
    const stalledContract = {
      ...baseContract,
      queryFilter: async () => {
        historyEntered.resolve();
        return stalledHistory;
      },
    };
    const connectedProviders: object[] = [];
    adapter.contracts.contextGraphStorage = {
      connect: (provider: object) => {
        connectedProviders.push(provider);
        return provider === stalledProvider ? stalledContract : baseContract;
      },
    };
    adapter.readTipProvider = async (
      _label: string,
      read: (provider: object) => Promise<unknown>,
    ) => {
      const stalledAttempt = read(stalledProvider);
      void stalledAttempt.catch(() => {});
      await historyEntered.promise;
      return read(healthyProvider);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        typedAdapter.getContextGraphAuthoritySnapshot(9n),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('healthy authority provider remained captured by stalled reader')),
            1_000,
          );
        }),
      ]);
      expect(result).toMatchObject({
        contextGraphId: '9',
        nameHash: NAME_HASH,
        sourceBlockNumber: '21',
      });
      expect(connectedProviders).toEqual([stalledProvider, healthyProvider]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  });

  it('discards the incremental watermark when its finalized anchor was replaced', async () => {
    const { adapter, evidence, advanceAuthorityHead, replaceCachedAnchor } =
      makeEvmAuthorityAdapter();
    await adapter.getContextGraphAuthoritySnapshot(9n);
    advanceAuthorityHead();
    replaceCachedAnchor();

    await expect(adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      publishPolicy: 1,
      policyVersion: '4',
    });
    expect(evidence.deploymentReads).toHaveLength(2);
    expect(evidence.ranges.slice(18)).toEqual(
      Array.from({ length: 6 }, () => [[7, 16], [17, 26], [27, 35]]).flat(),
    );
  });

  it('clears cached generations when ContextGraphStorage rotates', async () => {
    const { adapter, evidence, rotateContextGraphStorage } = makeEvmAuthorityAdapter();
    await adapter.getContextGraphAuthoritySnapshot(9n);
    rotateContextGraphStorage();
    await adapter.getContextGraphAuthoritySnapshot(9n);
    expect(evidence.deploymentReads).toHaveLength(2);
    expect(evidence.ranges).toHaveLength(36);
  });

  it('does not advance the history watermark when a late snapshot field fails to decode', async () => {
    const harness = makeEvmAuthorityAdapter();
    await harness.adapter.getContextGraphAuthoritySnapshot(9n);
    harness.advanceAuthorityHead();
    harness.setPublishAuthorityAccountId('not-a-uint256');
    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n)).rejects.toThrow();
    harness.setPublishAuthorityAccountId(7n);

    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      publishAuthorityAccountId: '7',
      policyVersion: '4',
    });
    expect(harness.evidence.ranges.slice(18)).toEqual(Array(10).fill([31, 35]));
  });

  it('provides the same authority surface in offline mock-chain mode', async () => {
    const mock = new MockChainAdapter('mock:31337', OWNER);
    const created = await mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: 0n,
      participantAgents: [MEMBER],
      nameHash: NAME_HASH,
    });

    await expect(mock.getContextGraphAuthoritySnapshot(created.contextGraphId))
      .resolves.toMatchObject({
        chainId: '31337',
        contextGraphId: created.contextGraphId.toString(10),
        owner: OWNER,
        accessPolicy: 1,
        publishPolicy: 0,
        publishAuthority: AUTHORITY,
        participantAgents: [MEMBER],
        nameHash: NAME_HASH,
        ownershipEra: '0',
        policyVersion: '0',
        rosterVersion: '0',
      });
  });

  it('advances mock authority high-waters and source evidence across every mutation class', async () => {
    const mock = new MockChainAdapter('mock:31337', OWNER);
    const created = await mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: 0n,
      participantAgents: [MEMBER],
      nameHash: NAME_HASH,
    });
    let accepted: ContextGraphAuthoritySnapshot | undefined;
    const accept = (snapshot: ContextGraphAuthoritySnapshot) => {
      if (accepted !== undefined) {
        const policyChanged = snapshot.owner !== accepted.owner
          || snapshot.publishPolicy !== accepted.publishPolicy
          || snapshot.publishAuthority !== accepted.publishAuthority
          || snapshot.publishAuthorityAccountId !== accepted.publishAuthorityAccountId;
        const rosterChanged = snapshot.participantAgents.join(',')
          !== accepted.participantAgents.join(',');
        if (policyChanged) {
          expect(BigInt(snapshot.sourceBlockNumber))
            .toBeGreaterThan(BigInt(accepted.sourceBlockNumber));
          expect(snapshot.sourceBlockHash).not.toBe(accepted.sourceBlockHash);
          expect(BigInt(snapshot.policyVersion))
            .toBeGreaterThan(BigInt(accepted.policyVersion));
        } else {
          expect(snapshot.sourceBlockNumber).toBe(accepted.sourceBlockNumber);
          expect(snapshot.sourceBlockHash).toBe(accepted.sourceBlockHash);
          expect(snapshot.policyVersion).toBe(accepted.policyVersion);
        }
        if (snapshot.owner !== accepted.owner) {
          expect(BigInt(snapshot.ownershipEra))
            .toBeGreaterThan(BigInt(accepted.ownershipEra));
        }
        if (rosterChanged) {
          expect(BigInt(snapshot.rosterVersion))
            .toBeGreaterThan(BigInt(accepted.rosterVersion));
        }
      }
      accepted = snapshot;
    };
    const readAndAccept = async () => {
      const snapshot = await mock.getContextGraphAuthoritySnapshot(created.contextGraphId);
      accept(snapshot);
      return snapshot;
    };
    const expectSource = (
      snapshot: ContextGraphAuthoritySnapshot,
      tx: { blockNumber: number },
    ) => {
      expect(snapshot.sourceBlockNumber).toBe(tx.blockNumber.toString(10));
      expect(snapshot.sourceBlockHash)
        .toBe(`0x${tx.blockNumber.toString(16).padStart(64, '0')}`);
    };

    const initial = await readAndAccept();
    expect(initial).toMatchObject({
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
    });
    expectSource(initial, created);

    await mock.addContextGraphParticipantAgent(
      created.contextGraphId,
      SECOND_MEMBER,
    );
    const afterAdd = await readAndAccept();
    expect(afterAdd).toMatchObject({
      participantAgents: [MEMBER, SECOND_MEMBER],
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '1',
    });
    expect(afterAdd.sourceBlockNumber).toBe(initial.sourceBlockNumber);
    expect(afterAdd.sourceBlockHash).toBe(initial.sourceBlockHash);

    await mock.removeContextGraphParticipantAgent(
      created.contextGraphId,
      SECOND_MEMBER,
    );
    const afterRemove = await readAndAccept();
    expect(afterRemove).toMatchObject({
      participantAgents: [MEMBER],
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '2',
    });
    expect(afterRemove.sourceBlockNumber).toBe(initial.sourceBlockNumber);
    expect(afterRemove.sourceBlockHash).toBe(initial.sourceBlockHash);

    const authorityUpdated = await mock.__updateContextGraphPublishAuthority(
      created.contextGraphId,
      SECOND_AUTHORITY,
    );
    const afterAuthority = await readAndAccept();
    expect(afterAuthority).toMatchObject({
      publishAuthority: SECOND_AUTHORITY,
      ownershipEra: '0',
      policyVersion: '1',
      rosterVersion: '2',
    });
    expectSource(afterAuthority, authorityUpdated);

    const policyUpdated = await mock.__updateContextGraphPublishPolicy(
      created.contextGraphId,
      1,
    );
    const afterPolicy = await readAndAccept();
    expect(afterPolicy).toMatchObject({
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      ownershipEra: '0',
      policyVersion: '2',
      rosterVersion: '2',
    });
    expectSource(afterPolicy, policyUpdated);

    const transferred = await mock.__transferContextGraphOwnership(
      created.contextGraphId,
      SECOND_MEMBER,
    );
    const afterTransfer = await readAndAccept();
    expect(afterTransfer).toMatchObject({
      owner: SECOND_MEMBER,
      ownershipEra: '1',
      policyVersion: '3',
      rosterVersion: '3',
    });
    expectSource(afterTransfer, transferred);

    const ownerCuratedMock = new MockChainAdapter('mock:31338', OWNER);
    const ownerCurated = await ownerCuratedMock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: OWNER,
      publishAuthorityAccountId: 0n,
      participantAgents: [MEMBER],
      nameHash: NAME_HASH,
    });
    const ownerCuratedInitial = await ownerCuratedMock.getContextGraphAuthoritySnapshot(
      ownerCurated.contextGraphId,
    );
    expect(ownerCuratedInitial).toMatchObject({
      owner: OWNER,
      publishAuthority: OWNER,
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
    });

    const ownerCuratedTransfer = await ownerCuratedMock.__transferContextGraphOwnership(
      ownerCurated.contextGraphId,
      SECOND_MEMBER,
    );
    const ownerCuratedAfterTransfer = await ownerCuratedMock.getContextGraphAuthoritySnapshot(
      ownerCurated.contextGraphId,
    );
    expect(ownerCuratedAfterTransfer).toMatchObject({
      owner: SECOND_MEMBER,
      publishAuthority: SECOND_MEMBER,
      publishAuthorityAccountId: '0',
      ownershipEra: '1',
      policyVersion: '2',
      rosterVersion: '1',
    });
    expectSource(ownerCuratedAfterTransfer, ownerCuratedTransfer);
  });
});
