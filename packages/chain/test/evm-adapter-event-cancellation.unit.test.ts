import type { ServerResponse } from 'node:http';
import { Contract, Interface, ZeroAddress } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from './hub-binding-test-fixture.js';
import type { ChainEvent, EventFilter } from '../src/chain-adapter.js';
import { selectEvmEventPlan } from '../src/evm-event-contracts.js';
import { createLoopbackJsonRpcTestHarness, sendJsonRpcResult } from './loopback-rpc-harness.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const address = '0x0000000000000000000000000000000000000012';
const eventNames = [
  'KnowledgeBatchCreated', 'ContextGraphExpanded', 'KnowledgeAssetRegisteredToContextGraph',
  'KnowledgeAssetCreated', 'KnowledgeAssetsMinted', 'NameClaimed', 'ContextGraphCreated',
  'RelayCapabilityUpdated',
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function installBindings(adapter: EVMChainAdapter, bindings: Record<string, unknown>): void {
  const internal = adapter as any;
  internal.installHubContractBindingsForTesting({ ...internal.contracts, ...bindings });
}

function adapterAt(rpcUrl = 'http://127.0.0.1:59998', rpcUrls?: string[]) {
  const adapter = new EVMChainAdapter({ rpcUrl, rpcUrls, privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
  const contract = new Contract(address, [
    ...eventNames.map(name => `event ${name}()`),
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  ], adapter.getProvider());
  installBindings(adapter, {
    knowledgeAssetsStorage: contract, knowledgeAssetStorage: contract,
    contextGraphStorage: contract, contextGraphNameRegistry: contract, profileStorage: contract,
  });
  return adapter;
}
async function collect(adapter: EVMChainAdapter, filter: EventFilter) {
  const events: ChainEvent[] = [];
  for await (const event of adapter.listenForEvents(filter)) events.push(event);
  return events;
}

describe('event scan RPC cancellation', () => {
  it('keeps a cold KCCreated scan independent of V10 lifecycle readiness', async () => {
    const hub = new Interface([
      'function getContractAddress(string name) view returns (address)',
      'function getAssetStorageAddress(string name) view returns (address)',
    ]);
    const requests: string[] = [];
    const rpc = createLoopbackJsonRpcTestHarness();
    const server = await rpc.start(async (payload, response) => {
      let result: unknown = '0x7a69';
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: (payload.params[0] as { data: string }).data });
        if (!call) throw new Error('expected Hub lookup');
        requests.push(String(call.args[0]));
        result = hub.encodeFunctionResult(call.fragment, [address]);
      } else if (payload.method === 'eth_getLogs') {
        result = [];
      }
      sendJsonRpcResult(response, payload, result);
    });
    const adapter = new EVMChainAdapter({ rpcUrl: server.url,
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    try {
      expect(adapter.isV10Ready()).toBe(false);
      expect(await collect(adapter, { eventTypes: ['KCCreated'], fromBlock: 1, toBlock: 20 })).toEqual([]);
      expect(requests).toEqual(['DKGKnowledgeAssets']);
      expect(adapter.isV10Ready()).toBe(false);
      await expect(adapter.resolveV10FinalizationReadiness()).resolves.toBe(true);
      expect(requests).toEqual(['DKGKnowledgeAssets', 'KnowledgeAssetsLifecycle']);
    } finally {
      adapter.destroy();
      await rpc.stopAll();
    }
  });

  it('keeps cold V10 readiness observable across Hub lifecycle registration', async () => {
    const hub = new Interface([
      'function getContractAddress(string name) view returns (address)',
      'function getAssetStorageAddress(string name) view returns (address)',
    ]);
    let lifecycleAddress = ZeroAddress;
    const lifecycleLookups: string[] = [];
    const rpc = createLoopbackJsonRpcTestHarness();
    const server = await rpc.start(async (payload, response) => {
      let result: unknown = '0x7a69';
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: (payload.params[0] as { data: string }).data });
        if (!call) throw new Error('expected Hub lookup');
        const name = String(call.args[0]);
        if (name === 'KnowledgeAssetsLifecycle') lifecycleLookups.push(name);
        result = hub.encodeFunctionResult(call.fragment, [
          name === 'KnowledgeAssetsLifecycle' ? lifecycleAddress : address,
        ]);
      } else if (payload.method === 'eth_blockNumber') {
        result = '0x64';
      } else if (payload.method === 'eth_getLogs') {
        result = [];
      }
      sendJsonRpcResult(response, payload, result);
    });
    const adapter = new EVMChainAdapter({ rpcUrl: server.url,
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const internal = adapter as any;
    try {
      await expect(adapter.resolveV10FinalizationReadiness()).resolves.toBe(false);
      expect(internal.hubRotationPoller.isStarted).toBe(true);
      lifecycleAddress = address;
      internal.applyHubRotationEventName('KnowledgeAssetsLifecycle');
      await expect(adapter.resolveV10FinalizationReadiness()).resolves.toBe(true);
      expect(lifecycleLookups).toEqual(['KnowledgeAssetsLifecycle', 'KnowledgeAssetsLifecycle']);
    } finally {
      adapter.destroy();
      await rpc.stopAll();
    }
  });

  it('retries cold V10 readiness while Hub rotation listener startup remains disabled', async () => {
    const hub = new Interface([
      'function getContractAddress(string name) view returns (address)',
      'function getAssetStorageAddress(string name) view returns (address)',
    ]);
    let lifecycleAddress = ZeroAddress;
    const lifecycleLookups: string[] = [];
    const rpc = createLoopbackJsonRpcTestHarness();
    const server = await rpc.start(async (payload, response) => {
      let result: unknown = '0x7a69';
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: (payload.params[0] as { data: string }).data });
        if (!call) throw new Error('expected Hub lookup');
        const name = String(call.args[0]);
        if (name === 'KnowledgeAssetsLifecycle') lifecycleLookups.push(name);
        result = hub.encodeFunctionResult(call.fragment, [
          name === 'KnowledgeAssetsLifecycle' ? lifecycleAddress : address,
        ]);
      }
      sendJsonRpcResult(response, payload, result);
    });
    const adapter = new EVMChainAdapter({ rpcUrl: server.url,
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const internal = adapter as any;
    internal.startHubRotationListener = vi.fn(async () => undefined);
    try {
      await expect(adapter.resolveV10FinalizationReadiness()).resolves.toBe(false);
      expect(internal.hubRotationPoller.isStarted).toBe(false);
      lifecycleAddress = address;
      await expect(adapter.resolveV10FinalizationReadiness()).resolves.toBe(true);
      expect(internal.startHubRotationListener).toHaveBeenCalledTimes(2);
      expect(lifecycleLookups).toEqual(['KnowledgeAssetsLifecycle', 'KnowledgeAssetsLifecycle']);
    } finally {
      adapter.destroy();
      await rpc.stopAll();
    }
  });

  it('retires an aborted event scan while Hub rotation-listener startup is pending', async () => {
    const adapter = adapterAt();
    const internal = adapter as any;
    const entered = deferred<void>();
    const release = deferred<void>();
    internal.startHubRotationListener = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const read = vi.spyOn(internal, 'readContractWith');
    const controller = new AbortController();
    const reason = new Error('poll admission closed during listener startup');
    const polling = collect(adapter, {
      eventTypes: ['ContextGraphCreated'], fromBlock: 1, toBlock: 20, signal: controller.signal,
    });
    try {
      await entered.promise;
      controller.abort(reason);
      expect(read).not.toHaveBeenCalled();
      release.resolve();
      await expect(polling).rejects.toBe(reason);
      expect(read).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await polling.catch(() => {});
      adapter.destroy();
    }
  });

  it('resolves the current Token after cold initialization outlives the rotation replay window', async () => {
    const rpc = createLoopbackJsonRpcTestHarness();
    const hub = new Interface([
      'function getContractAddress(string name) view returns (address)',
      'function getAssetStorageAddress(string name) view returns (address)',
      'event ContractChanged(string contractName, address newContractAddress)',
    ]);
    const replacement = '0x0000000000000000000000000000000000000034';
    const rotationBlock = 110;
    const rotation = hub.encodeEventLog(hub.getEvent('ContractChanged')!, ['Token', replacement]);
    let head = 100;
    let tokenAddress = address;
    let paused = false;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const scanStarts: number[] = [];
    const server = await rpc.start(async (payload, response) => {
      let result: unknown = '0x7a69';
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: (payload.params[0] as { data: string }).data });
        if (!call) throw new Error('expected Hub lookup');
        const name = String(call.args[0]);
        if (name === 'RandomSampling' && !paused) { paused = true; await released; }
        result = hub.encodeFunctionResult(call.fragment, [name === 'Token' ? tokenAddress : address]);
      } else if (payload.method === 'eth_blockNumber') {
        result = `0x${head.toString(16)}`;
      } else if (payload.method === 'eth_getLogs') {
        const filter = payload.params[0] as { fromBlock: string; toBlock: string };
        const from = Number(filter.fromBlock);
        scanStarts.push(from);
        result = from <= rotationBlock && Number(filter.toBlock) >= rotationBlock ? [{
          address, blockNumber: '0x6e', blockHash: `0x${'11'.repeat(32)}`,
          transactionHash: `0x${'22'.repeat(32)}`, transactionIndex: '0x0', logIndex: '0x0',
          removed: false, ...rotation,
        }] : [];
      }
      sendJsonRpcResult(response, payload, result);
    });
    const adapter = new EVMChainAdapter({ rpcUrl: server.url,
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const internal = adapter as unknown as {
      init(): Promise<void>; contracts: { token?: Contract };
      hubRotationPoller: { inFlight: Promise<void> | null; pollOnce(): Promise<void> };
    };
    const initialization = internal.init();
    try {
      await vi.waitFor(() => expect(paused).toBe(true));
      tokenAddress = replacement;
      head = 200; // The rotation at 110 is now outside the 50-block replay window.
      release();
      await initialization;
      await internal.hubRotationPoller.inFlight;
      await internal.hubRotationPoller.pollOnce();
      expect(scanStarts.length).toBeGreaterThan(0);
      expect(scanStarts.every(from => from > rotationBlock)).toBe(true);
      expect(await internal.contracts.token?.getAddress()).toBe(replacement);
    } finally {
      release();
      await initialization.catch(() => {});
      adapter.destroy();
      await rpc.stopAll();
    }
  });

  it.each(['Staking', 'Token', 'RandomSampling'])('reloads event bindings when Hub rotation overlaps full initialization at %s', async pausedName => {
    const hub = new Interface([
      'function getContractAddress(string name) view returns (address)',
      'function getAssetStorageAddress(string name) view returns (address)',
    ]);
    const replacement = '0x0000000000000000000000000000000000000034';
    let currentStorage = address;
    let pauseInitialization = true;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const scans: string[] = [];
    const storageLookups: string[] = [];
    const rpc = createLoopbackJsonRpcTestHarness();
    const server = await rpc.start(async (payload, response) => {
      let result: unknown = '0x7a69';
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: (payload.params[0] as { data: string }).data });
        if (!call) throw new Error('expected Hub lookup');
        const name = String(call.args[0]);
        if (name === pausedName && pauseInitialization) {
          pauseInitialization = false;
          enter();
          await released;
        }
        const resolved = name === 'ContextGraphStorage' ? currentStorage : address;
        if (name === 'ContextGraphStorage') storageLookups.push(resolved);
        result = hub.encodeFunctionResult(call.fragment, [resolved]);
      } else if (payload.method === 'eth_getLogs') {
        scans.push((payload.params[0] as { address: string }).address.toLowerCase());
        result = [];
      }
      sendJsonRpcResult(response, payload, result);
    });
    const adapter = new EVMChainAdapter({ rpcUrl: server.url,
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const internal = adapter as unknown as {
      initialized: boolean; contracts: { contextGraphStorage?: Contract };
      init(): Promise<void>; applyHubRotationEventName(name: string): void;
    };
    const filter = { eventTypes: ['ContextGraphCreated'], fromBlock: 1, toBlock: 20 };
    let initialization: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await collect(adapter, filter);
      expect(internal.initialized).toBe(false);
      initialization = internal.init();
      await Promise.race([entered, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('full initialization never reached the paused lookup')), 2000);
      })]);
      expect(await internal.contracts.contextGraphStorage?.getAddress()).toBe(address);
      currentStorage = replacement;
      internal.applyHubRotationEventName('ContextGraphStorage');
      release();
      await initialization;
      scans.length = 0;
      await collect(adapter, filter);
      expect(scans).toEqual([replacement]);
      expect(storageLookups).toEqual([address, replacement]);
      expect(await internal.contracts.contextGraphStorage?.getAddress()).toBe(replacement);
    } finally {
      clearTimeout(timeout);
      release();
      await initialization?.catch(() => {});
      adapter.destroy();
      await rpc.stopAll();
    }
  });

  it.each(['head', 'scan'] as const)('physically cancels a hung %s HTTP request without trying the backup', async boundary => {
    let entered!: () => void;
    const requestEntered = new Promise<void>(resolve => { entered = resolve; });
    let disconnected!: () => void;
    const requestDisconnected = new Promise<void>(resolve => { disconnected = resolve; });
    const methods: string[] = [];
    const rpc = createLoopbackJsonRpcTestHarness();
    const server = await rpc.start(async (payload, response) => {
      if (payload.method === 'eth_chainId') {
        sendJsonRpcResult(response, payload, '0x7a69');
        return;
      }
      methods.push(payload.method);
      response.on('close', disconnected);
      entered();
      // No response: only transport cancellation can retire this request.
    });
    const rpcUrl = server.url;
    const adapter = adapterAt(rpcUrl, [`${rpcUrl}/backup`]);
    const controller = new AbortController();
    const pending = (boundary === 'head'
      ? adapter.getBlockNumber({ signal: controller.signal })
      : collect(adapter, { eventTypes: ['KnowledgeAssetRegisteredToContextGraph'], fromBlock: 1, toBlock: 20, signal: controller.signal })
    ).then(() => ({ failed: false }), error => ({ failed: true, error }));
    try {
      await requestEntered;
      controller.abort(new Error('poll generation stopped'));
      expect(await pending).toMatchObject({ failed: true });
      await requestDisconnected;
      expect(methods.filter(method => method === (boundary === 'head' ? 'eth_blockNumber' : 'eth_getLogs')))
        .toHaveLength(1);
    } finally {
      controller.abort();
      adapter.destroy();
      await rpc.stopAll();
      await pending;
    }
  });

  it('keeps a shared Hub-cache request independent from cancellable event initialization', async () => {
    const hub = new Interface(['function getContractAddress(string name) view returns (address)']);
    let sharedEntered!: () => void;
    let eventEntered!: () => void;
    let eventDisconnected!: () => void;
    const sharedRequest = new Promise<void>(resolve => { sharedEntered = resolve; });
    const eventRequest = new Promise<void>(resolve => { eventEntered = resolve; });
    const disconnected = new Promise<void>(resolve => { eventDisconnected = resolve; });
    let sharedResponse: Pick<ServerResponse, 'destroyed'> | undefined;
    let releaseShared: (() => void) | undefined;
    const requests: string[] = [];
    async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${label} did not settle independently`)), 2_000);
        })]);
      } finally { clearTimeout(timeout); }
    }
    const rpc = createLoopbackJsonRpcTestHarness();
    const server = await rpc.start(async (payload, response, request) => {
      const reply = (result: unknown) => sendJsonRpcResult(response, payload, result);
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: (payload.params[0] as { data: string }).data });
        if (!call || call.args[0] !== 'ProfileStorage') throw new Error('unexpected event binding');
        requests.push(request.url ?? '');
        if (requests.length === 1) {
          sharedResponse = response;
          releaseShared = () => {
            if (!response.writableEnded && !response.destroyed) reply(hub.encodeFunctionResult(call.fragment, [address]));
          };
          sharedEntered();
        } else {
          response.on('close', eventDisconnected);
          eventEntered();
        }
        return;
      }
      reply(payload.method === 'eth_getLogs' ? [] : '0x7a69');
    });
    const rpcUrl = server.url;
    const adapter = new EVMChainAdapter({ rpcUrl, rpcUrls: [`${rpcUrl}/backup`],
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const internal = adapter as unknown as { resolveContract(name: string): Promise<Contract> };
    const controller = new AbortController();
    const shared = internal.resolveContract('ProfileStorage');
    let sharedSettled = false;
    void shared.then(() => { sharedSettled = true; }, () => { sharedSettled = true; });
    let pending: Promise<unknown> | undefined;
    try {
      await bounded(sharedRequest, 'shared request entry');
      pending = collect(adapter, { eventTypes: ['RelayCapabilityUpdated'], signal: controller.signal })
        .then(() => ({ completed: true }), error => ({ error }));
      await bounded(eventRequest, 'separate event request entry');
      const reason = new Error('event owner stopped');
      controller.abort(reason);
      expect(await bounded(pending, 'event retirement')).toEqual({ error: reason });
      await bounded(disconnected, 'event socket cancellation');
      expect(sharedSettled).toBe(false);
      expect(sharedResponse?.destroyed).toBe(false);
      expect(requests).toEqual(['/', '/']);

      releaseShared!();
      expect(await (await bounded(shared, 'original owner completion')).getAddress()).toBe(address);
      expect(sharedSettled).toBe(true);
      expect(await collect(adapter, { eventTypes: ['RelayCapabilityUpdated'] })).toEqual([]);
      expect(requests).toEqual(['/', '/']); // Retry reuses the original owner's completed Hub address.
    } finally {
      controller.abort();
      releaseShared?.();
      adapter.destroy();
      await rpc.stopAll();
      await Promise.allSettled([shared, pending]);
    }
  });

  it.each([
    ['ProfileStorage', ['RelayCapabilityUpdated'], ['ProfileStorage']],
    ['DKGKnowledgeAssets', ['KCCreated'], ['DKGKnowledgeAssets']],
    ['KnowledgeAssetsStorage', ['KnowledgeBatchCreated'], ['KnowledgeAssetsStorage']],
    ['ContextGraphNameRegistry', ['NameClaimed'], ['ContextGraphNameRegistry']],
    ['ContextGraphStorage', ['ContextGraphCreated'], ['ContextGraphStorage']],
    ['ContextGraphStorage', ['KCCreated', 'ContextGraphCreated'],
      ['DKGKnowledgeAssets', 'ContextGraphStorage']],
  ] as const)('physically cancels only the requested event group at %s without fallback', async (
    stalledName, eventTypes, capabilityNames,
  ) => {
    const hub = new Interface([
      'function getContractAddress(string name) view returns (address)',
      'function getAssetStorageAddress(string name) view returns (address)',
    ]);
    const requests: { path: string; name: string }[] = [];
    let stall = true;
    let entered!: () => void;
    const requestEntered = new Promise<void>(resolve => { entered = resolve; });
    let disconnected!: () => void;
    const requestDisconnected = new Promise<void>(resolve => { disconnected = resolve; });
    const rpc = createLoopbackJsonRpcTestHarness();
    const server = await rpc.start(async (payload, response, request) => {
      let result: unknown = '0x7a69';
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: (payload.params[0] as { data: string }).data });
        if (!call) throw new Error('expected Hub lookup');
        const name = String(call.args[0]);
        requests.push({ path: request.url ?? '', name });
        if (stall && name === stalledName) {
          response.on('close', disconnected);
          entered();
          return;
        }
        result = hub.encodeFunctionResult(call.fragment, [address]);
      } else if (payload.method === 'eth_getLogs') {
        result = [];
      }
      sendJsonRpcResult(response, payload, result);
    });
    const rpcUrl = server.url;
    const adapter = new EVMChainAdapter({ rpcUrl, rpcUrls: [`${rpcUrl}/backup`],
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const internal = adapter as unknown as {
      initialized: boolean; contracts: Record<string, unknown>; init(): Promise<void>;
      applyHubRotationEventName(name: string): void;
    };
    const beforeBindings = { ...internal.contracts };
    const controller = new AbortController();
    const reason = new Error('initializing poll stopped');
    const pending = collect(adapter, { eventTypes: [...eventTypes], signal: controller.signal })
      .then(() => ({ failed: false }), error => ({ failed: true, error }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await requestEntered;
      controller.abort(reason);
      const outcome = await Promise.race([
        Promise.all([pending, requestDisconnected]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('initialization did not physically cancel')), 750);
        }),
      ]);
      expect(outcome[0]).toEqual({ failed: true, error: reason });
      expect(requests.every(request => request.path === '/')).toBe(true);
      expect(requests.filter(request => request.name === stalledName)).toHaveLength(1);
      expect(internal.initialized).toBe(false);
      expect(internal.contracts).toEqual(beforeBindings);
      const cancelledNames = requests.map(request => request.name);
      expect(cancelledNames).toContain(stalledName);
      expect(cancelledNames.every(name => new Set<string>(capabilityNames).has(name))).toBe(true);
      // Any sibling request that reached the server before abort still belongs
      // to this group; cancellation discards the complete atomic stage.
      stall = false;
      expect(await collect(adapter, { eventTypes: [...eventTypes] })).toEqual([]);
      expect(requests.slice(cancelledNames.length).map(request => request.name).sort())
        .toEqual([...capabilityNames].sort());
      expect(internal.initialized).toBe(false);
      // Successful subset admission installs into the canonical handle store;
      // cancelled staging above installed nothing and full initialization is pending.
      expect(Object.keys(internal.contracts).sort()).toEqual(Object.keys(beforeBindings).sort());
      for (const key of selectEvmEventPlan(eventTypes).bindings) {
        expect(internal.contracts[key]).toBeDefined();
      }
      expect(internal.contracts.identity).toBeUndefined();
      await collect(adapter, { eventTypes: [...eventTypes] });
      expect(requests).toHaveLength(cancelledNames.length + capabilityNames.length);
      internal.applyHubRotationEventName(stalledName);
      const beforeRotationRetry = requests.length;
      await collect(adapter, { eventTypes: [...eventTypes] });
      expect(requests.slice(beforeRotationRetry).map(request => request.name).sort())
        .toEqual([...capabilityNames].sort());
      // Global initialization composes completed event bindings rather than
      // loading them again, and still initializes its non-event capabilities.
      const beforeFullInit = requests.filter(request => request.name === stalledName).length;
      await internal.init();
      expect(internal.initialized).toBe(true);
      expect(requests.filter(request => request.name === stalledName)).toHaveLength(beforeFullInit);
      expect(internal.contracts.identity).toBeDefined();

    } finally {
      clearTimeout(timeout);
      controller.abort();
      adapter.destroy();
      await rpc.stopAll();
      await pending;
    }
  });

  it.each([{ eventTypes: [] }, { eventTypes: ['unsupported-event'] }])('does not initialize contracts for an empty event capability set $eventTypes', async ({ eventTypes }) => {
    const adapter = new EVMChainAdapter({ rpcUrl: 'http://127.0.0.1:59998',
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const init = vi.fn(async () => { throw new Error('global initializer entered'); });
    Object.assign(adapter, { init });
    try {
      expect(await collect(adapter, { eventTypes })).toEqual([]);
      expect(init).not.toHaveBeenCalled();
    } finally { adapter.destroy(); }
  });

  it.each([
    ['KnowledgeBatchCreated', 1], ['ContextGraphExpanded', 1],
    ['KnowledgeAssetRegisteredToContextGraph', 1], ['KCCreated', 3],
    ['KnowledgeAssetCreated', 3], ['NameClaimed', 1], ['ContextGraphNameClaimed', 1],
    ['ContextGraphCreated', 1], ['RelayCapabilityUpdated', 1],
  ] as const)('passes cancellation and canonical wide-scan policy through %s', async (eventType, count) => {
    const adapter = adapterAt();
    const contract = (adapter as unknown as { contracts: { contextGraphStorage: Contract } }).contracts.contextGraphStorage;
    // A log the bound ABI cannot decode is ignored, but still crosses the
    // per-log cancellation boundary on every supported scan branch.
    const parse = vi.spyOn(contract.interface, 'parseLog').mockReturnValue(null);
    const reader = vi.fn(async () => [{ topics: [], data: '0x', blockNumber: 11, transactionHash: 'fixture', transactionIndex: 0 }]);
    Object.assign(adapter, { readContractWith: reader });
    const controller = new AbortController();
    try {
      expect(await collect(adapter, { eventTypes: [eventType], fromBlock: 1, toBlock: 20, signal: controller.signal })).toEqual([]);
      expect(reader).toHaveBeenCalledTimes(count);
      expect(parse).toHaveBeenCalledTimes(count);
      for (const call of reader.mock.calls as unknown as unknown[][]) {
        expect(call[3]).toEqual({ policy: 'wideLogScan', skipPreferred: true, signal: controller.signal });
      }
    } finally { adapter.destroy(); }
  });

  it('passes the requested block bounds to the physical event query', async () => {
    const adapter = adapterAt();
    const queryFilter = vi.fn(async () => []);
    const reader = vi.fn(async (_contract: unknown, _label: string, read: (contract: unknown) => Promise<unknown>) =>
      read({ queryFilter }));
    Object.assign(adapter, { readContractWith: reader });
    try {
      await collect(adapter, { eventTypes: ['ContextGraphCreated'], fromBlock: 7, toBlock: 19 });
      expect(queryFilter).toHaveBeenCalledOnce();
      expect(queryFilter.mock.calls[0]?.slice(1)).toEqual([7, 19]);
    } finally { adapter.destroy(); }
  });

  it('rejects a completed event page when its Hub binding generation rotated during the scan', async () => {
    const adapter = adapterAt();
    const internal = adapter as unknown as {
      invalidateHubContractBindings(): void;
      readContractWith: (
        contract: unknown,
        label: string,
        read: (contract: { queryFilter: () => Promise<unknown[]> }) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    internal.readContractWith = async (_contract, _label, read) => {
      const result = await read({ queryFilter: async () => [] });
      internal.invalidateHubContractBindings();
      return result;
    };
    try {
      await expect(collect(adapter, {
        eventTypes: ['ContextGraphCreated'],
        fromBlock: 101,
        toBlock: 120,
      })).rejects.toThrow('Hub contract bindings changed during event scan');
    } finally { adapter.destroy(); }
  });

  it('cancels between yielded logs before parsing or dispatching the next event', async () => {
    const adapter = adapterAt();
    const contract = new Contract(address, [
      'event ContextGraphExpanded(uint256 contextGraphId, uint256 batchId)',
    ], adapter.getProvider());
    const encoded = contract.interface.encodeEventLog('ContextGraphExpanded', [1n, 2n]);
    const parse = vi.spyOn(contract.interface, 'parseLog');
    const logs = [11, 12].map(blockNumber => ({ ...encoded, blockNumber, transactionHash: `tx-${blockNumber}` }));
    installBindings(adapter, { contextGraphStorage: contract });
    Object.assign(adapter, { readContractWith: async () => logs });
    const controller = new AbortController();
    const iterator = adapter.listenForEvents({ eventTypes: ['ContextGraphExpanded'], signal: controller.signal })[Symbol.asyncIterator]();
    try {
      expect(await iterator.next()).toMatchObject({ done: false, value: { blockNumber: 11 } });
      controller.abort(new Error('stop between events'));
      await expect(iterator.next()).rejects.toThrow('stop between events');
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { adapter.destroy(); }
  });

  it.each([1, 2, 3])('does not continue or fall back after cancellation at KCCreated read %i', async stopAt => {
    const adapter = adapterAt();
    const controller = new AbortController();
    let calls = 0;
    Object.assign(adapter, { readContractWith: async () => {
      if (++calls === stopAt) controller.abort(new Error('cancelled scan'));
      return []; // An adapter that returns an empty result after cancellation.
    } });
    try {
      await expect(collect(adapter, { eventTypes: ['KCCreated', 'ContextGraphCreated'], signal: controller.signal }))
        .rejects.toThrow('cancelled scan');
      expect(calls).toBe(stopAt);
    } finally { adapter.destroy(); }
  });
});

describe('event page Hub binding generation', () => {
  const RETIRED = '0x00000000000000000000000000000000000000aa';
  const REPLACEMENT = '0x00000000000000000000000000000000000000bb';

  it('fails a page rotated mid-scan and replays the same range against the replacement address', async () => {
    const hub = new Interface([
      'function getContractAddress(string name) view returns (address)',
      'function getAssetStorageAddress(string name) view returns (address)',
    ]);
    const rotatedAddresses = new Set([RETIRED, REPLACEMENT]);
    // Only the ContextGraphStorage scans; the rotation poller reads the Hub.
    const scanned: string[] = [];
    let contextGraphStorage = RETIRED;
    let rotateDuringNextScan = true;
    let rotate = (): void => {};
    const rpc = createLoopbackJsonRpcTestHarness();
    const server = await rpc.start(async (payload, response) => {
      let result: unknown = '0x7a69';
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: (payload.params[0] as { data: string }).data });
        if (!call) throw new Error('expected Hub lookup');
        result = hub.encodeFunctionResult(call.fragment, [
          String(call.args[0]) === 'ContextGraphStorage' ? contextGraphStorage : address,
        ]);
      } else if (payload.method === 'eth_getLogs') {
        const queried = String((payload.params[0] as { address?: string }).address ?? '').toLowerCase();
        if (rotatedAddresses.has(queried)) scanned.push(queried);
        // The rotation lands after the page captured its handles and while its
        // wide log scan is in flight — exactly the window the guard closes.
        if (queried === RETIRED && rotateDuringNextScan) {
          rotateDuringNextScan = false;
          rotate();
        }
        result = [];
      }
      sendJsonRpcResult(response, payload, result);
    });
    const adapter = new EVMChainAdapter({ rpcUrl: server.url,
      privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
    const internal = adapter as unknown as { applyHubRotationEventName(name: string): void };
    rotate = () => {
      contextGraphStorage = REPLACEMENT;
      internal.applyHubRotationEventName('ContextGraphStorage');
    };
    const page = { eventTypes: ['ContextGraphCreated'], fromBlock: 101, toBlock: 120 };
    try {
      // The scan itself succeeded against the retired address and returned no
      // events. Without the generation guard the page would complete and its
      // lane would checkpoint block 120, permanently skipping whatever the
      // replacement emitted in 101-120. It must fail instead.
      await expect(collect(adapter, page))
        .rejects.toThrow('Hub contract bindings changed during event scan');
      expect(scanned).toEqual([RETIRED]);
      // A failed page leaves the lane cursor where it was (proven for the lane
      // itself by the publisher's backoff/replay suite), so the replay covers
      // the same range — now against the address the Hub actually points at.
      expect(await collect(adapter, page)).toEqual([]);
      expect(scanned).toEqual([RETIRED, REPLACEMENT]);
    } finally {
      adapter.destroy();
      await rpc.stopAll();
    }
  });

  it('fails a page whose bindings rotated before its first descriptor scan', async () => {
    const adapter = adapterAt();
    const internal = adapter as unknown as { applyHubRotationEventName(name: string): void };
    const reader = vi.fn(async () => []);
    Object.assign(adapter, {
      ensureHubRotationListenerStarted: async () => {
        // A watcher that replays a rotation as it starts retires the generation
        // the page already resolved, before any descriptor has been scanned.
        internal.applyHubRotationEventName('ContextGraphStorage');
      },
      readContractWith: reader,
    });
    try {
      await expect(collect(adapter, { eventTypes: ['ContextGraphCreated'], fromBlock: 101, toBlock: 120 }))
        .rejects.toThrow('Hub contract bindings changed during event scan');
      expect(reader).not.toHaveBeenCalled();
    } finally { adapter.destroy(); }
  });
});
