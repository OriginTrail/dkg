// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import type { ContextGraphAuthoritySnapshot } from '../src/chain-adapter.js';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import {
  AUTHORITY,
  createAuthorityScenario,
  FINALIZED_HASH,
  GOVERNANCE,
  MEMBER,
  NAME_HASH,
  NEXT_POLICY_HASH,
  OWNER,
  POLICY_HASH,
  SECOND_AUTHORITY,
  SECOND_MEMBER,
} from './helpers/context-graph-authority-scenario.js';

interface AuthorityEvidence {
  readonly filters: Array<readonly [string, ...unknown[]]>;
  readonly ranges: Array<readonly [number, number]>;
  readonly staticCalls: Array<readonly [bigint, { blockTag: number }]>;
  readonly deploymentReads: Array<readonly [string, string, string]>;
  readonly readOptions: Array<Readonly<{ policy?: string; signal?: AbortSignal }>>;
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
  setPublishAuthorityAccountId(value: unknown): void;
  rotateContextGraphStorage(): void;
}

function makeEvmAuthorityAdapter(
  options: {
    reorg?: boolean;
    providerRangeLimit?: number;
  } = {},
): EvmAuthorityHarness {
  const scenario = createAuthorityScenario({ reorg: options.reorg });
  const adapter: any = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: GOVERNANCE,
    privateKey: `0x${'11'.repeat(32)}`,
    allowNoAdminSigner: true,
    chainId: 'evm:31337',
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
  };

  const contract = {
    interface: {
      getEvent: (name: string) => ({ topicHash: `topic:${name}` }),
      parseLog: (log: { parsed: unknown }) => log.parsed,
    },
    filters: Object.fromEntries([
      'ContextGraphCreated',
      'Transfer',
      'PublishPolicyUpdated',
      'PublishAuthorityUpdated',
      'AgentParticipantAdded',
      'AgentParticipantRemoved',
    ].map((name) => [
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
      return scenario.renderQueryFilter(filter.name, fromBlock, toBlock);
    },
    getContextGraph: {
      staticCall: async (contextGraphId: bigint, readOptions: { blockTag: number }) => {
        evidence.staticCalls.push([contextGraphId, readOptions]);
        expect(contextGraphId).toBe(9n);
        expect(readOptions).toEqual({ blockTag: scenario.finalizedNumber });
        return scenario.readCurrentState();
      },
    },
    getAddress: async () => GOVERNANCE,
  };
  const provider = {
    getBlock: (tag: string | number) => scenario.getBlock(tag),
    getNetwork: async () => ({ chainId: 31337n }),
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
  return {
    adapter: adapter as EVMChainAdapter,
    evidence,
    provider,
    advanceAuthorityHead: scenario.advanceAuthorityHead,
    replaceCachedAnchor: scenario.replaceCachedAnchor,
    replaceFinalizedHead: scenario.replaceFinalizedHead,
    holdCurrentStateRead: scenario.holdCurrentStateRead,
    holdBlockRead: scenario.holdBlockRead,
    setPublishAuthorityAccountId: scenario.setPublishAuthorityAccountId,
    rotateContextGraphStorage: () => adapter.applyHubRotationEventName('ContextGraphStorage'),
  };
}

describe('RFC-64 Context Graph authority snapshots', () => {
  it('uses one combined contract-wide log request per page when the durable index is wired', async () => {
    const { adapter, evidence } = makeEvmAuthorityAdapter({ sharedIndex: true });

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
    const harness = makeEvmAuthorityAdapter({ sharedIndex: true });
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

  it('projects stable per-CG revisions from one shared index advance', async () => {
    const { adapter, evidence, advanceAuthorityHead } = makeEvmAuthorityAdapter({
      sharedIndex: true,
    });

    const initial = await adapter.getContextGraphAuthorityIndexRevisions([9n, 10n]);
    expect(initial).toEqual([{
      contextGraphId: '9',
      revision: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
    }]);
    expect(evidence.indexRanges).toEqual([[7, 16], [17, 26], [27, 30]]);

    const unchanged = await adapter.getContextGraphAuthorityIndexRevisions([9n]);
    expect(unchanged).toEqual(initial);
    expect(evidence.indexRanges).toHaveLength(3);

    advanceAuthorityHead();
    const advanced = await adapter.getContextGraphAuthorityIndexRevisions([9n]);
    expect(advanced).toHaveLength(1);
    expect(advanced![0]!.revision).not.toBe(initial![0]!.revision);
    expect(evidence.indexRanges.slice(3)).toEqual([[31, 35]]);
  });

  it('rejects a stale revision projection and rebuilds from the replacement finalized fork', async () => {
    const harness = makeEvmAuthorityAdapter({ sharedIndex: true });
    const stabilization = harness.holdBlockRead(30);
    const stale = harness.adapter.getContextGraphAuthorityIndexRevisions([9n]);

    await stabilization.entered;
    harness.replaceAuthorityFork();
    stabilization.release();
    await expect(stale).rejects.toThrow('anchor changed');

    await expect(harness.adapter.getContextGraphAuthorityIndexRevisions([9n]))
      .resolves.toEqual([{
        contextGraphId: '9',
        revision: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      }]);
    expect(harness.evidence.indexInvalidations).toEqual([4]);
    expect(harness.evidence.indexRanges).toEqual([
      [7, 16], [17, 26], [27, 30],
      [7, 16], [17, 26], [27, 30],
    ]);
  });

  it('declines authority revision scheduling when no durable index is wired', async () => {
    const { adapter, evidence } = makeEvmAuthorityAdapter();
    await expect(adapter.getContextGraphAuthorityIndexRevisions([9n])).resolves.toBeNull();
    expect(evidence.indexRanges).toEqual([]);
  });

  it.each([
    ['finalized head', (harness: EvmAuthorityHarness) => harness.holdBlockRead('finalized')],
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

  it('fails over when a provider cannot supply an intermediate page anchor', async () => {
    const { adapter, provider } = makeEvmAuthorityAdapter({ sharedIndex: true });
    const attempts: string[] = [];
    const nonArchive = {
      ...provider,
      getBlock: async (tag: string | number) => {
        if (tag === 16) return null;
        return (provider.getBlock as (block: string | number) => Promise<unknown>)(tag);
      },
    };
    (adapter as any).readTipProvider = async (
      _label: string,
      read: (selected: typeof nonArchive) => Promise<unknown>,
      options: Readonly<{ isRetryable?: (error: unknown) => boolean }>,
    ) => {
      try {
        attempts.push('non-archive');
        return await read(nonArchive);
      } catch (error) {
        expect(options.isRetryable?.(error)).toBe(true);
        attempts.push('healthy');
        return read(provider as typeof nonArchive);
      }
    };

    await expect(adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      contextGraphId: '9',
      policyVersion: '3',
    });
    expect(attempts).toEqual(['non-archive', 'healthy']);
  });

  it('materializes deactivation from the shared event index without a point read', async () => {
    const { adapter, evidence } = makeEvmAuthorityAdapter({
      sharedIndex: true,
      deactivated: true,
    });

    await expect(adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      contextGraphId: '9',
      active: false,
      owner: OWNER,
      participantAgents: [OWNER, MEMBER],
    });
    expect(evidence.staticCalls).toEqual([]);
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
    harness.setPublishAuthorityAccountId(0n);

    await expect(harness.adapter.getContextGraphAuthoritySnapshot(9n)).resolves.toMatchObject({
      publishAuthorityAccountId: '0',
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
