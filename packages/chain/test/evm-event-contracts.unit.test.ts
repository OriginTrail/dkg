import { Contract, Interface, ZeroAddress, getAddress } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { ChainEvent } from '../src/chain-adapter.js';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  EVM_EVENT_DESCRIPTORS, eventContractKeysFor, evmEventDescriptorFor,
  type EvmEventCapabilityKey, type EvmEventDescriptor, type EvmEventScan,
} from '../src/evm-event-contracts.js';
import {
  ALL_EVM_HUB_CONTRACT_KEYS, EVM_HUB_CONTRACT_SPECS, EvmHubContractBindings,
  type EvmHubContractInstallation, type EvmHubContractKey, type EvmHubContractSpec,
} from '../src/evm-hub-contract-bindings.js';
import { HubContractNotFoundError } from '../src/hub-contract-not-found-error.js';

const first = new Contract('0x0000000000000000000000000000000000000001', []);
const second = new Contract('0x0000000000000000000000000000000000000002', []);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function completeInstallation(
  overrides: Partial<EvmHubContractInstallation> = {},
): EvmHubContractInstallation {
  return {
    hub: first,
    identity: first,
    profile: first,
    parametersStorage: first,
    knowledgeAssetStorage: first,
    ...overrides,
  };
}

describe('generation-owned Hub bindings and event selection', () => {
  it('shares one capability across aliases and repeated requested event types', () => {
    expect(eventContractKeysFor(['KCCreated', 'KnowledgeAssetCreated', 'KCCreated']))
      .toEqual(['knowledgeAssetStorage']);
    expect(eventContractKeysFor(['NameClaimed', 'ContextGraphNameClaimed']))
      .toEqual(['contextGraphNameRegistry']);
  });

  it('keeps a noncancellable caller independent of an aborted concurrent load', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const load = vi.fn(() => pending.promise);
    let settled = false;
    const ordinary = group.resolve(['contextGraphStorage'], load).finally(() => { settled = true; });
    const controller = new AbortController();
    const reason = new Error('event caller cancelled');
    const cancelled = vi.fn(async () => { controller.abort(reason); return second; });
    await expect(group.resolve(['contextGraphStorage'], cancelled, controller.signal)).rejects.toBe(reason);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    pending.resolve(first);
    await expect(ordinary).resolves.toEqual({ contextGraphStorage: first });
    const unused = vi.fn(async () => second);
    await expect(group.resolve(['contextGraphStorage'], unused)).resolves.toEqual({ contextGraphStorage: first });
    expect(unused).not.toHaveBeenCalled();
  });

  it('restarts a staged group when Hub rotation arrives during a lookup', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const load = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(second);
    const resolving = group.resolve(['contextGraphStorage'], load);
    group.invalidate();
    pending.resolve(first);
    await expect(resolving).resolves.toEqual({ contextGraphStorage: second });
    expect(load).toHaveBeenCalledTimes(2);
    await expect(group.resolve(['contextGraphStorage'], load)).resolves.toEqual({ contextGraphStorage: second });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('merges concurrently completed disjoint groups without losing either capability', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const firstGroup = group.resolve(['contextGraphStorage'], () => pending.promise);
    await group.resolve(['knowledgeAssetStorage'], async () => second);
    pending.resolve(first);
    await firstGroup;
    const unused = vi.fn(async () => first);
    await expect(group.resolve(['contextGraphStorage', 'knowledgeAssetStorage'], unused))
      .resolves.toEqual({ contextGraphStorage: first, knowledgeAssetStorage: second });
    expect(unused).not.toHaveBeenCalled();
  });

  it('retains the first committed handle when a concurrent same-generation load completes late', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const slow = group.resolve(['contextGraphStorage'], () => pending.promise);
    await group.resolve(['contextGraphStorage'], async () => second);
    pending.resolve(first);
    await expect(slow).resolves.toEqual({ contextGraphStorage: second });
    expect(group.contracts.contextGraphStorage).toBe(second);
  });

  it('caches an authoritative missing optional deployment until the Hub generation changes', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const load = vi.fn()
      .mockRejectedValueOnce(new HubContractNotFoundError('ContextGraphNameRegistry', String(first.target)))
      .mockResolvedValue(first);
    await expect(group.resolve(['contextGraphNameRegistry'], load)).resolves.toEqual({ contextGraphNameRegistry: undefined });
    await group.resolve(['contextGraphNameRegistry'], load);
    expect(load).toHaveBeenCalledOnce();
    group.invalidate();
    await expect(group.resolve(['contextGraphNameRegistry'], load)).resolves.toEqual({ contextGraphNameRegistry: first });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('retries a transient optional-deployment lookup instead of caching absence', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const failure = new Error('temporary RPC failure');
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(first);
    await expect(group.resolve(['chronos'], load)).rejects.toBe(failure);
    expect(group.resolvedKeys.has('chronos')).toBe(false);
    await expect(group.resolve(['chronos'], load)).resolves.toEqual({ chronos: first });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not retain any staged bindings when a required contract fails', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const failure = new Error('KA storage unavailable');
    const load = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(failure).mockResolvedValue(second);
    const keys = ['contextGraphStorage', 'knowledgeAssetStorage'] as const;
    await expect(group.resolve(keys, load)).rejects.toBe(failure);
    expect(group.contracts.contextGraphStorage).toBeUndefined();
    expect(group.contracts.knowledgeAssetStorage).toBeUndefined();
    await expect(group.resolve(keys, load)).resolves.toEqual({ contextGraphStorage: second, knowledgeAssetStorage: second });
    expect(load).toHaveBeenCalledTimes(4);
  });
});

/** Installed handles and decided keys must always describe the same generation. */
function expectAgreement(group: EvmHubContractBindings, decided: ReadonlyMap<EvmHubContractKey, Contract | undefined>): void {
  expect([...group.resolvedKeys].sort()).toEqual([...decided.keys()].sort());
  for (const [key, handle] of decided) expect(group.contracts[key]).toBe(handle);
  if (group.initialized) expect(group.resolvedKeys.size).toBe(ALL_EVM_HUB_CONTRACT_KEYS.length);
}

function decidedAs(handleFor: (key: EvmHubContractKey) => Contract | undefined): Map<EvmHubContractKey, Contract | undefined> {
  return new Map(ALL_EVM_HUB_CONTRACT_KEYS.map(key => [key, handleFor(key)]));
}

describe('Hub binding generation ownership', () => {
  it('install decides every boot key at once and runs no loader for the installed generation', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const store = completeInstallation({ contextGraphStorage: second });
    group.install(store);
    expect(group.contracts).toBe(store);
    expect(group.initialized).toBe(true);
    expectAgreement(group, decidedAs(key => store[key]));
    const loader = vi.fn(async () => first);
    await expect(group.resolve(['contextGraphStorage', 'knowledgeAssetStorage'], loader))
      .resolves.toEqual({ contextGraphStorage: second, knowledgeAssetStorage: first });
    expect(loader).not.toHaveBeenCalled();
  });

  it('invalidate retires readiness and decisions while retaining handles unless dropped', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    group.install(completeInstallation({ contextGraphStorage: second }));
    group.invalidate(['knowledgeAssetStorage']);
    expect(group.initialized).toBe(false);
    expectAgreement(group, new Map());
    // Retained for operations that already passed init; dropped handles are gone.
    expect(group.contracts.contextGraphStorage).toBe(second);
    expect(group.contracts.knowledgeAssetStorage).toBeUndefined();
    const loader = vi.fn(async () => first);
    await expect(group.resolve(['contextGraphStorage', 'knowledgeAssetStorage'], loader))
      .resolves.toEqual({ contextGraphStorage: first, knowledgeAssetStorage: first });
    expect(loader).toHaveBeenCalledTimes(2);
    expectAgreement(group, new Map([['contextGraphStorage', first], ['knowledgeAssetStorage', first]]));
  });

  it('publishes readiness only for a completely decided, still current generation', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const generation = group.generation;
    await group.resolve(['contextGraphStorage'], async () => first);
    expect(() => group.completeInitialization(generation)).toThrow('cannot publish readiness before resolving: identity');
    expect(group.initialized).toBe(false);
    const loader = vi.fn(async (spec: EvmHubContractSpec) => spec.resolution === 'optional-deployment' ? undefined : second);
    await group.resolve(ALL_EVM_HUB_CONTRACT_KEYS, loader);
    expect(loader).toHaveBeenCalledTimes(ALL_EVM_HUB_CONTRACT_KEYS.length - 1);
    expect(group.completeInitialization(generation)).toBe(true);
    expect(group.initialized).toBe(true);
    expectAgreement(group, decidedAs(key => key === 'contextGraphStorage'
      ? first
      : EVM_HUB_CONTRACT_SPECS[key].resolution === 'optional-deployment' ? undefined : second));
    group.invalidate();
    expect(group.completeInitialization(generation)).toBe(false);
    expect(group.initialized).toBe(false);
    expectAgreement(group, new Map());
  });

  it('an install during a staged lookup wins and the stale lookup commits nothing', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const resolving = group.resolve(['contextGraphStorage'], () => pending.promise);
    const store = completeInstallation({ contextGraphStorage: second });
    group.install(store);
    pending.resolve(first);
    await expect(resolving).resolves.toEqual({ contextGraphStorage: second });
    expect(store.contextGraphStorage).toBe(second);
    expectAgreement(group, decidedAs(key => store[key]));
  });

  it('rejects a production install that omits a required binding', () => {
    const group = new EvmHubContractBindings({ hub: first });
    expect(() => group.install({ hub: first } as EvmHubContractInstallation))
      .toThrow('missing required handles: identity, profile, parametersStorage, knowledgeAssetStorage');
  });
});

// ---------------------------------------------------------------------------
// Descriptor registry: every supported event resolves its declared binding
// and invokes its declared scan.
// ---------------------------------------------------------------------------

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const address = '0x0000000000000000000000000000000000000012';
const EVENT_ABI = [
  'event RelayCapabilityUpdated(uint72 indexed identityId, bool oldValue, bool newValue)',
  'event KnowledgeAssetCreated(uint256 indexed id, bytes32 merkleRoot, uint88 byteSize, address indexed author)',
  'event KnowledgeAssetsMinted(address indexed to, uint256 startId, uint256 endId)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event KnowledgeBatchCreated(uint256 indexed batchId, address indexed publisher, bytes32 merkleRoot, uint256 startKAId, uint256 endKAId)',
  'event NameClaimed(bytes32 indexed nameHash, address indexed creator, uint8 accessPolicy)',
  'event ContextGraphExpanded(uint256 indexed contextGraphId, uint256 batchId)',
  'event KnowledgeAssetRegisteredToContextGraph(uint256 indexed contextGraphId, uint256 indexed kaId)',
  'event ContextGraphCreated(uint256 indexed contextGraphId, address indexed owner, uint8 accessPolicy, uint8 publishPolicy, bytes32 nameHash)',
];
const eventInterface = new Interface(EVENT_ABI);
const ROOT = '0x' + '55'.repeat(32);
const NAME_HASH = '0x' + 'ab'.repeat(32);
const AUTHOR = getAddress('0x' + 'a1'.repeat(20));
const OWNER = getAddress('0x' + 'b2'.repeat(20));
const MINT_RECIPIENT = getAddress('0x' + 'c3'.repeat(20));
const ALIASES = EVM_EVENT_DESCRIPTORS.flatMap(descriptor => descriptor.aliases.map(alias => [alias, descriptor] as const));
const EVENT_CAPABILITY_KEYS: readonly EvmEventCapabilityKey[] = eventContractKeysFor(
  EVM_EVENT_DESCRIPTORS.flatMap(descriptor => descriptor.aliases),
);

type EncodedLog = ReturnType<typeof eventInterface.encodeEventLog> & { blockNumber: number; transactionHash: string; transactionIndex: number };
function logOf(event: string, values: unknown[], blockNumber: number, transactionHash: string, transactionIndex = 0): EncodedLog {
  return { ...eventInterface.encodeEventLog(event, values), blockNumber, transactionHash, transactionIndex };
}

async function collectAll(events: AsyncIterable<ChainEvent>): Promise<ChainEvent[]> {
  const collected: ChainEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function* asyncLogs(logs: readonly EncodedLog[]): AsyncIterable<EncodedLog> {
  yield* logs;
}

/** One parsing scenario per canonical descriptor, keyed by its first alias; logs are keyed by query label in query order. */
const SCENARIOS: Record<string, { logs: Record<string, EncodedLog[]>; expected: ChainEvent[] }> = {
  RelayCapabilityUpdated: {
    logs: { 'profileStorage.queryFilter(RelayCapabilityUpdated)': [logOf('RelayCapabilityUpdated', [7n, false, true], 11, 'tx-relay')] },
    expected: [{ type: 'RelayCapabilityUpdated', blockNumber: 11, data: { identityId: '7', oldValue: false, newValue: true, txHash: 'tx-relay' } }],
  },
  KCCreated: {
    logs: {
      'kas.queryFilter(KnowledgeAssetCreated)': [
        logOf('KnowledgeAssetCreated', [5n, ROOT, 1024n, AUTHOR], 12, 'tx-legacy', 1),
        logOf('KnowledgeAssetCreated', [6n, ROOT, 2048n, AUTHOR], 13, 'tx-greenfield', 2),
        logOf('KnowledgeAssetCreated', [7n, ROOT, 4096n, AUTHOR], 14, 'tx-author', 3),
      ],
      'kas.queryFilter(KnowledgeAssetsMinted)': [logOf('KnowledgeAssetsMinted', [MINT_RECIPIENT, 5n, 7n], 12, 'tx-legacy', 1)],
      'kas.queryFilter(Transfer)': [logOf('Transfer', [ZeroAddress, OWNER, 6n], 13, 'tx-greenfield', 2)],
    },
    expected: [
      // Legacy mint range wins, greenfield Transfer owner next, attested author last.
      { type: 'KCCreated', blockNumber: 12, data: { kaId: '5', merkleRoot: ROOT, merkleRootBytes: ROOT, byteSize: '1024', txHash: 'tx-legacy', txIndex: 1, publisherAddress: MINT_RECIPIENT, author: AUTHOR, startKAId: '5', endKAId: '6' } },
      { type: 'KCCreated', blockNumber: 13, data: { kaId: '6', merkleRoot: ROOT, merkleRootBytes: ROOT, byteSize: '2048', txHash: 'tx-greenfield', txIndex: 2, publisherAddress: OWNER, author: AUTHOR, startKAId: '6', endKAId: '6' } },
      { type: 'KCCreated', blockNumber: 14, data: { kaId: '7', merkleRoot: ROOT, merkleRootBytes: ROOT, byteSize: '4096', txHash: 'tx-author', txIndex: 3, publisherAddress: AUTHOR, author: AUTHOR, startKAId: '7', endKAId: '7' } },
    ],
  },
  KnowledgeBatchCreated: {
    logs: { 'kasV9.queryFilter(KnowledgeBatchCreated)': [logOf('KnowledgeBatchCreated', [3n, OWNER, ROOT, 1n, 2n], 15, 'tx-batch', 4)] },
    expected: [{ type: 'KnowledgeBatchCreated', blockNumber: 15, data: { batchId: '3', publisherAddress: OWNER, merkleRoot: ROOT, startKAId: '1', endKAId: '2', txHash: 'tx-batch', txIndex: 4 } }],
  },
  NameClaimed: {
    logs: { 'cgNameRegistry.queryFilter(NameClaimed)': [logOf('NameClaimed', [NAME_HASH, AUTHOR, 1], 16, 'tx-name')] },
    expected: [{ type: 'NameClaimed', blockNumber: 16, data: { contextGraphId: NAME_HASH, creator: AUTHOR, accessPolicy: 1, txHash: 'tx-name' } }],
  },
  ContextGraphExpanded: {
    logs: { 'cgStorage.queryFilter(ContextGraphExpanded)': [logOf('ContextGraphExpanded', [9n, 4n], 17, 'tx-expand')] },
    expected: [{ type: 'ContextGraphExpanded', blockNumber: 17, data: { contextGraphId: '9', batchId: '4', txHash: 'tx-expand' } }],
  },
  KnowledgeAssetRegisteredToContextGraph: {
    logs: { 'cgStorage.queryFilter(KnowledgeAssetRegisteredToContextGraph)': [logOf('KnowledgeAssetRegisteredToContextGraph', [9n, 5n], 18, 'tx-register', 5)] },
    expected: [{ type: 'KnowledgeAssetRegisteredToContextGraph', blockNumber: 18, data: { contextGraphId: '9', kaId: '5', txHash: 'tx-register', txIndex: 5 } }],
  },
  ContextGraphCreated: {
    logs: { 'cgStorage.queryFilter(ContextGraphCreated)': [logOf('ContextGraphCreated', [9n, OWNER, 1, 2, NAME_HASH], 19, 'tx-create')] },
    expected: [{ type: 'ContextGraphCreated', blockNumber: 19, data: { contextGraphId: '9', creator: OWNER, owner: OWNER, accessPolicy: 1, publishPolicy: 2, nameHash: NAME_HASH, txHash: 'tx-create' } }],
  },
};

describe('EVM event descriptor registry', () => {
  it('defines each alias once and selects bindings in declaration order regardless of request order', () => {
    const aliases = EVM_EVENT_DESCRIPTORS.flatMap(descriptor => descriptor.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(Object.keys(SCENARIOS).sort()).toEqual(EVM_EVENT_DESCRIPTORS.map(descriptor => descriptor.aliases[0]).sort());
    expect(eventContractKeysFor([...aliases].reverse())).toEqual(EVENT_CAPABILITY_KEYS);
    expect(eventContractKeysFor(['unsupported-event'])).toEqual([]);
    expect(evmEventDescriptorFor('unsupported-event')).toBeUndefined();
  });

  it.each(ALIASES)('%s scans its declared binding and parses every log shape of its descriptor', async (alias, descriptor: EvmEventDescriptor) => {
    const scenario = SCENARIOS[descriptor.aliases[0]];
    expect(evmEventDescriptorFor(alias)).toBe(descriptor);
    expect(eventContractKeysFor([alias])).toEqual([descriptor.binding]);
    const contract = new Contract(address, EVENT_ABI);
    const queried: string[] = [];
    const scan: EvmEventScan = {
      query: (queriedContract, label) => {
        expect(queriedContract).toBe(contract);
        queried.push(label);
        return asyncLogs(scenario.logs[label] ?? []);
      },
    };
    expect(await collectAll(descriptor.scan(contract, scan))).toEqual(scenario.expected);
    expect(queried).toEqual(Object.keys(scenario.logs));
  });

  it.each(ALIASES)('listenForEvents resolves %s from the registry and scans only its declared binding', async (alias, descriptor: EvmEventDescriptor) => {
    const adapter = new EVMChainAdapter({ rpcUrl: 'http://127.0.0.1:59998', privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const bindings = Object.fromEntries(EVENT_CAPABILITY_KEYS.map((key, index) =>
      [key, new Contract(`0x${String(index + 1).padStart(40, '0')}`, EVENT_ABI, adapter.getProvider())]));
    const reader = vi.fn(async () => []);
    const internal = adapter as any;
    internal.installHubContractBindingsForTesting({ ...internal.contracts, ...bindings });
    internal.readContractWith = reader;
    try {
      expect(await collectAll(adapter.listenForEvents({ eventTypes: [alias] }))).toEqual([]);
      expect(reader).toHaveBeenCalled();
      for (const call of reader.mock.calls as unknown as unknown[][]) expect(call[0]).toBe(bindings[descriptor.binding]);
    } finally { adapter.destroy(); }
  });

  it('uses the same transient optional-binding contract for subset and ordinary consumers', async () => {
    const adapter = new EVMChainAdapter({ rpcUrl: 'http://127.0.0.1:59998', privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const contract = new Contract(address, EVENT_ABI, adapter.getProvider());
    const failure = new Error('temporary ProfileStorage RPC failure');
    let profileAttempts = 0;
    const internal = adapter as any;
    internal.loadHubContractBinding = vi.fn(async (spec: EvmHubContractSpec) => {
      if (spec.name === 'ProfileStorage' && profileAttempts++ < 2) throw failure;
      return contract;
    });
    internal.resolveAndAssignRandomSamplingPair = vi.fn(async () => undefined);
    internal.startHubRotationListener = vi.fn(async () => undefined);
    internal.readContract = vi.fn(async () => true);
    internal.readContractWith = vi.fn(async () => []);
    try {
      await expect(collectAll(adapter.listenForEvents({ eventTypes: ['RelayCapabilityUpdated'] })))
        .rejects.toBe(failure);
      await expect(adapter.getRelayCapable(7n)).rejects.toBe(failure);
      await expect(adapter.getRelayCapable(7n)).resolves.toBe(true);
      expect(profileAttempts).toBe(3);
    } finally { adapter.destroy(); }
  });

  it('keeps lifecycle readiness behind the explicit finalization capability', async () => {
    const adapter = new EVMChainAdapter({ rpcUrl: 'http://127.0.0.1:59998', privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const eventContract = new Contract(address, EVENT_ABI, adapter.getProvider());
    const lifecycleContract = new Contract('0x0000000000000000000000000000000000000013', [], adapter.getProvider());
    const loaded: string[] = [];
    const internal = adapter as any;
    internal.loadHubContractBinding = vi.fn(async (spec: EvmHubContractSpec) => {
      loaded.push(spec.name);
      if (spec.name === 'DKGKnowledgeAssets') return eventContract;
      if (spec.name === 'KnowledgeAssetsLifecycle') return lifecycleContract;
      throw new Error(`unexpected binding ${spec.name}`);
    });
    internal.startHubRotationListener = vi.fn(async () => undefined);
    internal.readContractWith = vi.fn(async () => []);
    try {
      await expect(collectAll(adapter.listenForEvents({ eventTypes: ['KCCreated'] })))
        .resolves.toEqual([]);
      expect(loaded).toEqual(['DKGKnowledgeAssets']);
      await expect(adapter.resolveV10FinalizationReadiness()).resolves.toBe(true);
      expect(loaded).toEqual(['DKGKnowledgeAssets', 'KnowledgeAssetsLifecycle']);
    } finally { adapter.destroy(); }
  });

  it('KCCreated falls back to the attested author when Transfer enumeration fails, unless the scan was cancelled', async () => {
    const descriptor = evmEventDescriptorFor('KCCreated')!;
    const contract = new Contract(address, EVENT_ABI);
    const created = [logOf('KnowledgeAssetCreated', [6n, ROOT, 2048n, AUTHOR], 13, 'tx-greenfield', 2)];
    const controller = new AbortController();
    const reason = new Error('scan cancelled during Transfer enumeration');
    const scanWith = (signal?: AbortSignal): EvmEventScan => ({
      signal,
      query: (_contract, label) => (async function* queryLogs() {
        if (label === 'kas.queryFilter(Transfer)') {
          if (signal) controller.abort(reason);
          throw new Error('Transfer enumeration unavailable');
        }
        yield* asyncLogs(label === 'kas.queryFilter(KnowledgeAssetCreated)' ? created : []);
      }()),
    });
    expect(await collectAll(descriptor.scan(contract, scanWith()))).toEqual([
      { type: 'KCCreated', blockNumber: 13, data: { kaId: '6', merkleRoot: ROOT, merkleRootBytes: ROOT, byteSize: '2048', txHash: 'tx-greenfield', txIndex: 2, publisherAddress: AUTHOR, author: AUTHOR, startKAId: '6', endKAId: '6' } },
    ]);
    await expect(collectAll(descriptor.scan(contract, scanWith(controller.signal)))).rejects.toBe(reason);
  });
});
