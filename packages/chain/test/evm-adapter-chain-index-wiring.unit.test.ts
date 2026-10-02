// SPDX-License-Identifier: Apache-2.0

/**
 * ONE log per node, and the adapter that owns it.
 *
 * The rule the whole design rests on is that exactly one adapter in a process
 * builds a tick. These pin both halves: an adapter given no store builds
 * nothing (so the per-wallet publisher adapters can never become a second
 * scanner), and the one given a store attaches its binding before it starts.
 */

import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import type {
  ChainEventLogAuthoritySource,
  ChainEventLogBinding,
  ChainEventLogHubRotationWindow,
} from '../src/chain-event-log-binding.js';
import { createContextGraphAuthorityIndexCheckpoint } from
  '../src/context-graph-authority-index-checkpoint.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB_ADDRESS = '0x0000000000000000000000000000000000000001';
const RETIRED_CG_STORAGE = '0x00000000000000000000000000000000000000aa';
const ROTATED_CG_STORAGE = '0x00000000000000000000000000000000000000bb';
const KA_STORAGE = '0x00000000000000000000000000000000000000cc';
const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;

function config(store?: MemoryChainEventLogStore): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: HUB_ADDRESS,
    chainId: 'evm:31337',
    staticNetwork: false,
    allowNoAdminSigner: true,
    ...(store === undefined ? {} : { chainEventLogStore: store }),
  } as EVMAdapterConfig;
}

/** Stand in for the Hub the adapter would have resolved through `initContracts`. */
function stubHub(adapter: EVMChainAdapter): void {
  const internals = adapter as unknown as {
    contracts: Record<string, unknown>;
    readTipProvider: unknown;
    resolveContractDeployBlockNumber: unknown;
  };
  internals.contracts.hub = {
    interface: new ethers.Interface(loadAbi('Hub')),
    getAddress: async () => ethers.getAddress(HUB_ADDRESS),
  };
  internals.contracts.contextGraphStorage = undefined;
  internals.contracts.knowledgeAssetStorage = undefined;
  internals.resolveContractDeployBlockNumber = async () => 1;
  internals.readTipProvider = async (
    _label: string,
    read: (provider: unknown) => Promise<unknown>,
  ) => read({
    getBlock: async (tag: string | number) => ({
      number: typeof tag === 'number' ? tag : 500,
      hash: `0x${(typeof tag === 'number' ? tag : 500).toString(16).padStart(64, '0')}`,
      timestamp: 1_700_000_000,
    }),
    getLogs: async () => [],
  });
}

function startChainIndex(adapter: EVMChainAdapter): void {
  (adapter as unknown as { startChainIndexRuntime(): void }).startChainIndexRuntime();
}

function chainIndexOwner(adapter: EVMChainAdapter): Readonly<{
  starting?: Promise<void>;
  runtime?: unknown;
}> {
  return (adapter as unknown as {
    chainIndexOwner: Readonly<{ starting?: Promise<void>; runtime?: unknown }>;
  }).chainIndexOwner;
}

function oneLogScope(adapter: EVMChainAdapter): string {
  return [adapter.deploymentId, HUB_ADDRESS.toLowerCase()].join(':');
}

function finalizedCreationSource(
  read: NonNullable<ChainEventLogAuthoritySource['readContextGraphFinalizedCreation']>,
): ChainEventLogAuthoritySource {
  return {
    contractAddress: RETIRED_CG_STORAGE,
    pageSource: {} as ChainEventLogAuthoritySource['pageSource'],
    resolveAnchor: async () => ({ refusal: 'no-cursor' }),
    anchorHolds: async () => false,
    readContextGraphFinalizedCreation: read,
  };
}

function borrowedAuthorityBinding(
  adapter: EVMChainAdapter,
  source: ChainEventLogAuthoritySource,
): ChainEventLogBinding {
  return Object.freeze({
    scope: oneLogScope(adapter),
    subscription: {} as ChainEventLogBinding['subscription'],
    contextGraphStorageAddress: RETIRED_CG_STORAGE,
    contextGraphAuthority: source,
  });
}

async function waitForHubPollerIdle(adapter: EVMChainAdapter): Promise<void> {
  await vi.waitUntil(
    () => (adapter as unknown as {
      hubRotationPoller: { inFlight: Promise<void> | null };
    }).hubRotationPoller.inFlight === null,
    { timeout: 2_000 },
  );
}

/** `ContextGraphStorage` as `initContracts` would have resolved it. */
function stubContextGraphStorage(adapter: EVMChainAdapter, address: string): void {
  (adapter as unknown as { contracts: Record<string, unknown> })
    .contracts.contextGraphStorage = {
      interface: new ethers.Interface(loadAbi('ContextGraphStorage')),
      getAddress: async () => ethers.getAddress(address),
    };
}

/** What the Hub rotation listener calls when it sees a name move. */
function dispatchHubRotation(adapter: EVMChainAdapter, name: string): void {
  (adapter as unknown as { applyHubRotationEventName(name: string): void })
    .applyHubRotationEventName(name);
}

/** Stub only the Hub/RPC boundary while preserving the real initContracts path. */
function stubInitBoundary(adapter: EVMChainAdapter) {
  const rpcLabels: string[] = [];
  const contractReadLabels: string[] = [];
  const provider = {
    getBlock: async (tag: string | number) => ({
      number: typeof tag === 'number' ? tag : 100,
      hash: hash(typeof tag === 'number' ? tag : 100),
      timestamp: Math.floor(Date.now() / 1_000),
    }),
    getBlockNumber: async () => 100,
    getLogs: async () => [],
  };
  const contract = (abi: string, address: string) => ({
    interface: new ethers.Interface(loadAbi(abi)),
    getAddress: async () => ethers.getAddress(address),
  });
  const internals = adapter as unknown as {
    init(): Promise<void>;
    contracts: Record<string, unknown>;
    resolveContract(name: string): Promise<unknown>;
    resolveAssetStorage(name: string): Promise<unknown>;
    resolveAndAssignRandomSamplingPair(): Promise<void>;
    resolveContractDeployBlockNumber(): Promise<number>;
    readProvider(label: string, read: (provider: unknown) => Promise<unknown>): Promise<unknown>;
    readTipProvider(label: string, read: (provider: unknown) => Promise<unknown>): Promise<unknown>;
    readContract(contract: unknown, label: string): Promise<unknown>;
    readContractWithOptions(contract: unknown, label: string): Promise<unknown>;
    hubRotationPoller: { pollOnce(): Promise<void> };
  };
  internals.contracts.hub = contract('Hub', HUB_ADDRESS);
  internals.resolveContract = async (name) => {
    if (['Identity', 'Profile', 'ParametersStorage', 'ContextGraphs'].includes(name)) return {};
    throw new Error(`${name} is optional in this fixture`);
  };
  internals.resolveAssetStorage = async (name) => {
    if (name === 'DKGKnowledgeAssets') return contract('DKGKnowledgeAssets', KA_STORAGE);
    if (name === 'ContextGraphStorage') {
      return contract('ContextGraphStorage', RETIRED_CG_STORAGE);
    }
    throw new Error(`${name} is optional in this fixture`);
  };
  internals.resolveAndAssignRandomSamplingPair = async () => {
    throw new Error('RandomSampling is optional in this fixture');
  };
  internals.resolveContractDeployBlockNumber = async () => 1;
  internals.readProvider = async (label, read) => {
    rpcLabels.push(label);
    return read(provider);
  };
  internals.readTipProvider = async (label, read) => {
    rpcLabels.push(label);
    return read(provider);
  };
  internals.readContract = async (_contract, label) => {
    contractReadLabels.push(label);
    return ethers.ZeroAddress;
  };
  internals.readContractWithOptions = async (_contract, label) => {
    contractReadLabels.push(label);
    return 0n;
  };
  return { internals, rpcLabels, contractReadLabels };
}

describe('EVMChainAdapter chain index wiring', () => {
  it('activates every one-log reader through the real init entry point', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter({ ...config(store), indexTickMs: 60_000 });
    const { internals, rpcLabels, contractReadLabels } = stubInitBoundary(adapter);

    await internals.init();
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    await vi.waitUntil(
      async () => await store.load(oneLogScope(adapter)) !== undefined,
      { timeout: 2_000 },
    );

    const now = Date.now();
    const contextGraphInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
    const encode = (name: string, args: readonly unknown[], blockNumber: number, logIndex: number) => {
      const event = contextGraphInterface.encodeEventLog(
        contextGraphInterface.getEvent(name)!,
        [...args],
      );
      return {
        blockNumber,
        blockHash: hash(blockNumber),
        logIndex,
        transactionHash: hash(0xaa),
        address: RETIRED_CG_STORAGE.toLowerCase(),
        topics: [...event.topics],
        data: event.data,
        settled: true,
      };
    };
    store.seed(oneLogScope(adapter), {
      cursor: {
        revision: 1,
        lineage: hash(1),
        deploymentBlockNumber: 1,
        settledBlockNumber: 100,
        settledBlockHash: hash(100),
        head: {
          number: 100,
          hash: hash(100),
          timestampSeconds: Math.floor(now / 1_000),
          fetchedAtMs: now,
        },
        topicSetVersion: 'init-integration',
      },
      coverage: ['hub', 'context-graph-authority', 'context-graph-ka'].map((family) => ({
        family,
        address: family === 'hub' ? HUB_ADDRESS.toLowerCase() : RETIRED_CG_STORAGE.toLowerCase(),
        coveredFromBlock: 1,
        coveredThroughBlock: 100,
        floorBlock: 1,
      })),
    }, [
      encode('ContextGraphCreated', [
        7n,
        RETIRED_CG_STORAGE,
        hash(0x22),
        [RETIRED_CG_STORAGE],
        7n,
        1,
        0,
        RETIRED_CG_STORAGE,
        7n,
      ], 40, 0),
      encode('KnowledgeAssetRegisteredToContextGraph', [7n, 4242n], 50, 0),
    ]);

    const binding = adapter.chainEventLog!;
    expect(binding.contextGraphAuthority).toBeDefined();
    expect((await binding.contextGraphAuthority!.resolveAnchor({
      deploymentBlockNumber: 1,
      finalityConfirmations: 1,
    })).anchor?.finalized.number).toBe(100);

    rpcLabels.length = 0;
    contractReadLabels.length = 0;
    await internals.hubRotationPoller.pollOnce();
    expect(rpcLabels.filter((label) => label.startsWith('Hub_rotation_poll_'))).toEqual([]);
    expect(await adapter.getKAContextGraphId(4242n)).toBe(7n);
    expect(await adapter.getContextGraphKCAt(7n, 0n)).toBe(4242n);
    expect(contractReadLabels.filter((label) => label.startsWith('cgStorage.'))).toEqual([]);

    adapter.destroy();
  });

  it('builds NOTHING for an adapter the composition root gave no store', async () => {
    const adapter = new EVMChainAdapter(config());
    stubHub(adapter);
    startChainIndex(adapter);
    // Await the detached start itself, not a turn of the loop: a fixed number
    // of microtasks would let this pass simply by not having run yet, which is
    // the vacuous version of exactly this assertion.
    await chainIndexOwner(adapter).starting;

    // This is the "never two scanners" guarantee, stated where it is enforced.
    expect(adapter.chainEventLog).toBeUndefined();
    expect(chainIndexOwner(adapter).runtime).toBeUndefined();
    adapter.destroy();
  });

  it('lets a store-less borrower consume the owner finalized creation pair', async () => {
    let current: ChainEventLogBinding | undefined;
    const borrower = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: () => current,
    });
    stubContextGraphStorage(borrower, RETIRED_CG_STORAGE);
    (borrower as unknown as { initialized: boolean }).initialized = true;
    const read = vi.fn(async () => ({ nameHash: hash(0x22), accessPolicy: 1 as const }));
    current = borrowedAuthorityBinding(borrower, finalizedCreationSource(read));

    await expect(borrower.getContextGraphFinalizedCreation(7n)).resolves.toEqual({
      nameHash: hash(0x22),
      accessPolicy: 1,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(chainIndexOwner(borrower).runtime).toBeUndefined();
    borrower.destroy();
  });

  it('treats a rebuild gap as a fast-pair miss for unchanged live fallback', async () => {
    let current: ChainEventLogBinding | undefined;
    const borrower = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: () => current,
    });
    stubContextGraphStorage(borrower, RETIRED_CG_STORAGE);
    (borrower as unknown as { initialized: boolean }).initialized = true;

    current = undefined;
    await expect(borrower.getContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    expect(chainIndexOwner(borrower).runtime).toBeUndefined();
    borrower.destroy();
  });

  it('does not retain a point-row miss outside the owner projection', async () => {
    let current: ChainEventLogBinding | undefined;
    const borrower = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: () => current,
    });
    stubContextGraphStorage(borrower, RETIRED_CG_STORAGE);
    (borrower as unknown as { initialized: boolean }).initialized = true;
    const read = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ nameHash: hash(0x22), accessPolicy: 1 as const });
    current = borrowedAuthorityBinding(borrower, finalizedCreationSource(read));

    await expect(borrower.getContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    await expect(borrower.getContextGraphFinalizedCreation(7n)).resolves.toEqual({
      nameHash: hash(0x22),
      accessPolicy: 1,
    });
    expect(read).toHaveBeenCalledTimes(2);
    borrower.destroy();
  });

  it('rejects a late old-generation pair across same-address A to B to A rotation', async () => {
    let current: ChainEventLogBinding | undefined;
    const borrower = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: () => current,
    });
    stubContextGraphStorage(borrower, RETIRED_CG_STORAGE);
    (borrower as unknown as { initialized: boolean }).initialized = true;
    let release!: (value: { nameHash: string; accessPolicy: 1 }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const sourceA1 = finalizedCreationSource(() => new Promise((resolve) => {
      release = resolve;
      markStarted();
    }));
    const bindingA1 = borrowedAuthorityBinding(borrower, sourceA1);
    const bindingB = borrowedAuthorityBinding(
      borrower,
      finalizedCreationSource(async () => ({ nameHash: hash(0x33), accessPolicy: 1 })),
    );
    const bindingA2 = borrowedAuthorityBinding(
      borrower,
      finalizedCreationSource(async () => ({ nameHash: hash(0x22), accessPolicy: 0 })),
    );
    current = bindingA1;

    const late = borrower.getContextGraphFinalizedCreation(7n);
    await started;
    current = bindingB;
    current = bindingA2;
    release({ nameHash: hash(0x22), accessPolicy: 1 });

    await expect(late).resolves.toBeUndefined();
    await expect(borrower.getContextGraphFinalizedCreation(7n)).resolves.toEqual({
      nameHash: hash(0x22),
      accessPolicy: 0,
    });
    borrower.destroy();
  });

  it('rejects a source object replaced inside the same binding during the await', async () => {
    let current: ChainEventLogBinding | undefined;
    const borrower = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: () => current,
    });
    stubContextGraphStorage(borrower, RETIRED_CG_STORAGE);
    (borrower as unknown as { initialized: boolean }).initialized = true;
    let release!: (value: { nameHash: string; accessPolicy: 1 }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const sourceA = finalizedCreationSource(() => new Promise((resolve) => {
      release = resolve;
      markStarted();
    }));
    const sourceB = finalizedCreationSource(async () => ({
      nameHash: hash(0x33),
      accessPolicy: 1,
    }));
    let currentSource = sourceA;
    current = Object.freeze({
      scope: oneLogScope(borrower),
      subscription: {} as ChainEventLogBinding['subscription'],
      contextGraphStorageAddress: RETIRED_CG_STORAGE,
      get contextGraphAuthority() { return currentSource; },
    });

    const late = borrower.getContextGraphFinalizedCreation(7n);
    await started;
    currentSource = sourceB;
    release({ nameHash: hash(0x22), accessPolicy: 1 });

    await expect(late).resolves.toBeUndefined();
    borrower.destroy();
  });

  it('rejects a pair when the physical ContextGraphStorage rotates during the await', async () => {
    let current: ChainEventLogBinding | undefined;
    const borrower = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: () => current,
    });
    let currentAddress = RETIRED_CG_STORAGE;
    (borrower as unknown as { contracts: Record<string, unknown> })
      .contracts.contextGraphStorage = {
        interface: new ethers.Interface(loadAbi('ContextGraphStorage')),
        getAddress: async () => ethers.getAddress(currentAddress),
      };
    (borrower as unknown as { initialized: boolean }).initialized = true;
    let release!: (value: { nameHash: string; accessPolicy: 1 }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const source = finalizedCreationSource(() => new Promise((resolve) => {
      release = resolve;
      markStarted();
    }));
    current = borrowedAuthorityBinding(borrower, source);

    const late = borrower.getContextGraphFinalizedCreation(7n);
    await started;
    currentAddress = ROTATED_CG_STORAGE;
    release({ nameHash: hash(0x22), accessPolicy: 1 });

    await expect(late).resolves.toBeUndefined();
    borrower.destroy();
  });

  it('borrows only the current exact-scope binding and never retains a static fallback', () => {
    let current: ChainEventLogBinding | undefined;
    const borrower = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: () => current,
    });
    const matching = Object.freeze({
      scope: oneLogScope(borrower),
      subscription: {} as ChainEventLogBinding['subscription'],
    });

    // Cold start: absence means live behavior. A static attachment must not
    // become a hidden fallback that reappears during a later rebuild gap.
    borrower.attachChainEventLog(matching);
    expect(borrower.chainEventLog).toBeUndefined();
    expect(chainIndexOwner(borrower).binding).toBeUndefined();

    current = Object.freeze({ ...matching, scope: 'evm:1:hub=foreign:foreign' });
    expect(borrower.chainEventLog).toBeUndefined();

    current = matching;
    expect(borrower.chainEventLog).toBe(matching);

    current = undefined;
    expect(borrower.chainEventLog).toBeUndefined();
    borrower.destroy();
  });

  it('refuses an adapter configured to both own and borrow the one-log runtime', () => {
    expect(() => new EVMChainAdapter({
      ...config(new MemoryChainEventLogStore()),
      chainEventLogBindingSource: () => undefined,
    })).toThrow(/cannot own and borrow/i);
  });

  it('lets multiple borrowers share one scanner and fall back live after owner shutdown', async () => {
    const store = new MemoryChainEventLogStore();
    const owner = new EVMChainAdapter({ ...config(store), indexTickMs: 60_000 });
    const ownerBoundary = stubInitBoundary(owner);
    await ownerBoundary.internals.init();
    await vi.waitUntil(() => owner.chainEventLog !== undefined, { timeout: 2_000 });
    await vi.waitUntil(
      async () => await store.load(oneLogScope(owner)) !== undefined,
      { timeout: 2_000 },
    );

    const source = () => owner.chainEventLog;
    const borrowerA = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: source,
    });
    const borrowerB = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: source,
    });
    const boundaryA = stubInitBoundary(borrowerA);
    const boundaryB = stubInitBoundary(borrowerB);
    await boundaryA.internals.init();
    await boundaryB.internals.init();
    await waitForHubPollerIdle(borrowerA);
    await waitForHubPollerIdle(borrowerB);

    boundaryA.rpcLabels.length = 0;
    boundaryB.rpcLabels.length = 0;
    await boundaryA.internals.hubRotationPoller.pollOnce();
    await boundaryB.internals.hubRotationPoller.pollOnce();

    expect(chainIndexOwner(owner).runtime).toBeDefined();
    expect(chainIndexOwner(borrowerA).runtime).toBeUndefined();
    expect(chainIndexOwner(borrowerB).runtime).toBeUndefined();
    expect(boundaryA.rpcLabels.filter((label) => label.startsWith('Hub rotation poll'))).toEqual([]);
    expect(boundaryB.rpcLabels.filter((label) => label.startsWith('Hub rotation poll'))).toEqual([]);

    const ownedBinding = owner.chainEventLog;
    borrowerA.destroy();
    expect(owner.chainEventLog).toBe(ownedBinding);

    owner.destroy();
    expect(borrowerB.chainEventLog).toBeUndefined();
    boundaryB.rpcLabels.length = 0;
    await boundaryB.internals.hubRotationPoller.pollOnce();
    expect(boundaryB.rpcLabels).toEqual(expect.arrayContaining([
      'Hub rotation poll getBlockNumber',
      'Hub rotation poll getLogs',
    ]));
    borrowerB.destroy();
  });

  it('rejects an old borrowed generation completion but applies rotations from the current one', async () => {
    let current: ChainEventLogBinding | undefined;
    const borrower = new EVMChainAdapter({
      ...config(),
      chainEventLogBindingSource: () => current,
    });
    const boundary = stubInitBoundary(borrower);
    const rotations: string[] = [];
    const internals = borrower as unknown as {
      initialized: boolean;
      applyHubRotationEventName(name: string): void;
    };
    const applyRotation = internals.applyHubRotationEventName.bind(borrower);
    internals.applyHubRotationEventName = (name) => {
      rotations.push(name);
      applyRotation(name);
    };

    let readWindow: NonNullable<ChainEventLogBinding['readHubRotationWindow']> =
      async () => ({
      fromBlockNumber: 11,
      throughBlockNumber: 10,
      rotations: [],
      });
    const bindingA: ChainEventLogBinding = {
      scope: oneLogScope(borrower),
      subscription: {} as ChainEventLogBinding['subscription'],
      readHubRotationWindow: (...args) => readWindow(...args),
    };
    current = bindingA;
    await boundary.internals.init();
    await waitForHubPollerIdle(borrower);

    let releaseOld = (_window: ChainEventLogHubRotationWindow): void => {};
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    readWindow = () => new Promise((resolve) => {
      releaseOld = resolve;
      markStarted();
    });
    boundary.rpcLabels.length = 0;
    const oldPoll = boundary.internals.hubRotationPoller.pollOnce();
    await started;

    const bindingB: ChainEventLogBinding = {
      scope: oneLogScope(borrower),
      subscription: {} as ChainEventLogBinding['subscription'],
      readHubRotationWindow: async () => ({
        fromBlockNumber: 101,
        throughBlockNumber: 101,
        rotations: [{
          blockNumber: 101,
          blockHash: hash(101),
          logIndex: 0,
          contractName: 'ContextGraphStorage',
        }],
      }),
    };
    current = bindingB;
    internals.initialized = true;
    releaseOld({
      fromBlockNumber: 11,
      throughBlockNumber: 11,
      rotations: [{
        blockNumber: 11,
        blockHash: hash(11),
        logIndex: 0,
        contractName: 'DKGKnowledgeAssets',
      }],
    });
    await oldPoll;

    expect(rotations).toEqual([]);
    expect(internals.initialized).toBe(true);
    expect(boundary.rpcLabels).toEqual(expect.arrayContaining([
      'Hub rotation poll getBlockNumber',
      'Hub rotation poll getLogs',
    ]));

    boundary.rpcLabels.length = 0;
    await boundary.internals.hubRotationPoller.pollOnce();
    expect(rotations).toEqual(['ContextGraphStorage']);
    expect(internals.initialized).toBe(false);
    expect(boundary.rpcLabels.filter((label) => label.startsWith('Hub rotation poll'))).toEqual([]);
    borrower.destroy();
  });

  it('attaches the binding for the one adapter that owns the store', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });

    const binding = adapter.chainEventLog!;
    expect(typeof binding.readHubRotationWindow).toBe('function');
    // No ContextGraphStorage in this Hub, so no address is claimed — a reader
    // with none falls back rather than proving a range against a guess.
    expect(binding.contextGraphStorageAddress).toBeUndefined();
    adapter.destroy();
  });

  it('resumes the first one-log pass above the existing authority checkpoint', async () => {
    const store = new MemoryChainEventLogStore();
    const authorityStore = new MemoryAuthorityIndexStore();
    authorityStore.record = Object.freeze({
      token: 1,
      value: createContextGraphAuthorityIndexCheckpoint({
        deploymentBlockNumber: 1,
        throughBlockNumber: 400,
        throughBlockHash: hash(40),
      }, []),
    });
    const adapter = new EVMChainAdapter({
      ...config(store),
      localContextGraphAuthorityIndexStore: authorityStore,
    });
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);

    startChainIndex(adapter);
    await chainIndexOwner(adapter).starting;
    await vi.waitUntil(
      async () => await store.load(oneLogScope(adapter)) !== undefined,
      { timeout: 2_000 },
    );

    const authorityCoverage = (await store.load(oneLogScope(adapter)))?.coverage.find(
      (entry) => entry.family === 'context-graph-authority',
    );
    // The fixture head is 500: a cold start would begin at 450 (50-block
    // holdback), while the migrated prefix makes the first raw range 401.
    expect(authorityCoverage?.coveredFromBlock).toBe(401);
    adapter.destroy();
  });

  it('starts at most ONE runtime however often initContracts runs again', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    startChainIndex(adapter);
    // A Hub rotation re-runs `initContracts`; a second tick on the same cursor
    // would only lose the CAS and repeat the first one's requests. The
    // single-flight is asserted on the PROMISE, not on the field it assigns:
    // a later start overwrites that field asynchronously, so comparing it
    // would pass simply because the second attempt had not landed yet.
    const started = chainIndexOwner(adapter).starting;
    expect(started).toBeDefined();
    startChainIndex(adapter);
    startChainIndex(adapter);
    expect(chainIndexOwner(adapter).starting).toBe(started);

    await started;
    expect(adapter.chainEventLog).toBeDefined();
    adapter.destroy();
  });

  it('MOVES the binding when the Hub rotates a contract the log indexes', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(RETIRED_CG_STORAGE);

    // The Hub rebinds the name; `initContracts` re-resolves it, which is what
    // this assignment stands in for.
    stubContextGraphStorage(adapter, ROTATED_CG_STORAGE);
    dispatchHubRotation(adapter, 'ContextGraphStorage');

    // FIRST, and synchronously: the binding is gone. Everything the runtime
    // decides — its decoders, its floors, the addresses it publishes — was
    // fixed at construction, so until it is rebuilt the only honest thing it
    // can say is nothing, and every reader goes back to its own scan.
    expect(adapter.chainEventLog).toBeUndefined();

    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    // The one that matters. A binding still naming the retired proxy is a log
    // that answers "covered, and nothing happened" for every event the new
    // contract emits, and the lanes advance past them for good.
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(ROTATED_CG_STORAGE);
    adapter.destroy();
  });

  it('does not let an old-generation build restore a binding after rebuild', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);
    const internals = adapter as unknown as {
      resolveContractDeployBlockNumber: () => Promise<number>;
    };
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    internals.resolveContractDeployBlockNumber = async () => {
      await blocked;
      return 1;
    };

    startChainIndex(adapter);
    const oldStarting = chainIndexOwner(adapter).starting;
    expect(oldStarting).toBeDefined();
    dispatchHubRotation(adapter, 'ContextGraphStorage');
    expect(adapter.chainEventLog).toBeUndefined();

    release();
    await oldStarting;
    // The detached old build completed, but its generation was retired before
    // completion. It must stop itself without becoming current again.
    expect(adapter.chainEventLog).toBeUndefined();
    expect(chainIndexOwner(adapter).runtime).toBeUndefined();

    internals.resolveContractDeployBlockNumber = async () => 1;
    stubContextGraphStorage(adapter, ROTATED_CG_STORAGE);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(ROTATED_CG_STORAGE);
    adapter.destroy();
  });

  it('retires the old binding when bulk Hub self-heal re-resolves every contract', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(RETIRED_CG_STORAGE);

    (adapter as unknown as { invalidateAllBoundContracts(): void })
      .invalidateAllBoundContracts();
    expect(adapter.chainEventLog).toBeUndefined();

    stubContextGraphStorage(adapter, ROTATED_CG_STORAGE);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(ROTATED_CG_STORAGE);
    adapter.destroy();
  });

  it('builds from the contracts it held when it STARTED, not from after the await', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);
    const internals = adapter as unknown as {
      contracts: Record<string, unknown>;
      resolveContractDeployBlockNumber: unknown;
    };
    let release = (): void => {};
    const searching = new Promise<void>((resolve) => { release = () => { resolve(); }; });
    internals.resolveContractDeployBlockNumber = async () => {
      await searching;
      return 1;
    };

    startChainIndex(adapter);
    // What `invalidateHubBinding` does, landing while this detached build sits
    // inside a deploy-block search.
    internals.contracts.contextGraphStorage = undefined;
    release();
    await chainIndexOwner(adapter).starting;

    // Read after the await, that null would have built a log with no Context
    // Graph source at all — every reader falling back forever, for the lifetime
    // of the process, with nothing but a `console.warn` to say so.
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(RETIRED_CG_STORAGE);
    adapter.destroy();
  });

  it('leaves the log alone for a rotation of a contract it does not index', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    const binding = adapter.chainEventLog;

    // `ParametersStorage` is not in the tick's address array, so nothing about
    // the log became wrong. Tearing it down would spend a fresh deploy-block
    // search and a cold pass on every unrelated rotation.
    dispatchHubRotation(adapter, 'ParametersStorage');

    expect(adapter.chainEventLog).toBe(binding);
    adapter.destroy();
  });

  it('takes its interval from chain.indexTickMs and refuses an invalid one', async () => {
    const store = new MemoryChainEventLogStore();
    const rejected = new EVMChainAdapter({ ...config(store), indexTickMs: 0 });
    stubHub(rejected);
    startChainIndex(rejected);
    await chainIndexOwner(rejected).starting;

    // An operator who mis-set T must not silently get a tick on some other
    // cadence: every staleness bound on this node is derived from that number.
    expect(rejected.chainEventLog).toBeUndefined();
    rejected.destroy();

    const accepted = new EVMChainAdapter({ ...config(store), indexTickMs: 12_000 });
    stubHub(accepted);
    startChainIndex(accepted);
    await chainIndexOwner(accepted).starting;
    expect(accepted.chainEventLog).toBeDefined();
    accepted.destroy();
  });

  it('clears the binding on destroy so nothing reads a stopped log', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });

    adapter.destroy();
    expect(adapter.chainEventLog).toBeUndefined();
  });
});
