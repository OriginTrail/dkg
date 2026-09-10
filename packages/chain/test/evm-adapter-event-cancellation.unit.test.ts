import { createServer, type ServerResponse } from 'node:http';
import { Contract, Interface } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import type { ChainEvent, EventFilter } from '../src/chain-adapter.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const address = '0x0000000000000000000000000000000000000012';
const eventNames = [
  'KnowledgeBatchCreated', 'ContextGraphExpanded', 'KnowledgeAssetRegisteredToContextGraph',
  'KnowledgeAssetCreated', 'KnowledgeAssetsMinted', 'NameClaimed', 'ContextGraphCreated',
  'RelayCapabilityUpdated',
];
function adapterAt(rpcUrl = 'http://127.0.0.1:59998', rpcUrls?: string[]) {
  const adapter = new EVMChainAdapter({ rpcUrl, rpcUrls, privateKey: PRIVATE_KEY, hubAddress: address, chainId: 'evm:31337' });
  const contract = new Contract(address, [
    ...eventNames.map(name => `event ${name}()`),
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  ], adapter.getProvider());
  Object.assign(adapter, { initialized: true, contracts: {
    knowledgeAssetsStorage: contract, knowledgeAssetStorage: contract,
    contextGraphStorage: contract, contextGraphNameRegistry: contract, profileStorage: contract,
  } });
  return adapter;
}
async function collect(adapter: EVMChainAdapter, filter: EventFilter) {
  const events: ChainEvent[] = [];
  for await (const event of adapter.listenForEvents(filter)) events.push(event);
  return events;
}

describe('event scan RPC cancellation', () => {
  it.each(['head', 'scan'] as const)('physically cancels a hung %s HTTP request without trying the backup', async boundary => {
    let entered!: () => void;
    const requestEntered = new Promise<void>(resolve => { entered = resolve; });
    let disconnected!: () => void;
    const requestDisconnected = new Promise<void>(resolve => { disconnected = resolve; });
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      const payload = JSON.parse(body) as { method: string; id: number };
      if (payload.method === 'eth_chainId') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: '0x7a69' }));
        return;
      }
      methods.push(payload.method);
      response.on('close', disconnected);
      entered();
      // No response: only transport cancellation can retire this request.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('missing RPC listener');
    const rpcUrl = `http://127.0.0.1:${bound.port}`;
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
      expect(methods).toEqual([boundary === 'head' ? 'eth_blockNumber' : 'eth_getLogs']);
    } finally {
      controller.abort();
      adapter.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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
    let sharedResponse: ServerResponse | undefined;
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
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      const payload = JSON.parse(body) as { method: string; id: number; params: [{ data: string }] };
      const reply = (result: unknown) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
      };
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: payload.params[0].data });
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
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('missing RPC listener');
    const rpcUrl = `http://127.0.0.1:${bound.port}`;
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
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([shared, pending]);
    }
  });

  it.each([
    ['ProfileStorage', ['RelayCapabilityUpdated'], ['ProfileStorage']],
    ['DKGKnowledgeAssets', ['KCCreated'], ['DKGKnowledgeAssets']],
    ['KnowledgeAssetsStorage', ['KnowledgeBatchCreated'], ['KnowledgeAssetsStorage']],
    ['ContextGraphNameRegistry', ['NameClaimed'], ['ContextGraphNameRegistry']],
    ['ContextGraphStorage', ['ContextGraphCreated'], ['ContextGraphStorage']],
    ['ContextGraphStorage', ['KCCreated', 'ContextGraphCreated'], ['DKGKnowledgeAssets', 'ContextGraphStorage']],
  ] as const)('physically cancels only the requested event group at %s without fallback', async (stalledName, eventTypes, expectedNames) => {
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
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      const payload = JSON.parse(body) as { method: string; id: number; params: [{ data: string }] };
      let result: unknown = '0x7a69';
      if (payload.method === 'eth_call') {
        const call = hub.parseTransaction({ data: payload.params[0].data });
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
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('missing RPC listener');
    const rpcUrl = `http://127.0.0.1:${bound.port}`;
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
      expect(requests.map(request => request.name)).toEqual(expectedNames);
      // Even bindings resolved before the stalled lookup must be retried:
      // cancellation discards the entire staged capability group.
      stall = false;
      expect(await collect(adapter, { eventTypes: [...eventTypes] })).toEqual([]);
      expect(requests.map(request => request.name)).toEqual([...expectedNames, ...expectedNames]);
      expect(internal.initialized).toBe(false);
      expect(internal.contracts).toEqual(beforeBindings);
      await collect(adapter, { eventTypes: [...eventTypes] });
      expect(requests.map(request => request.name)).toEqual([...expectedNames, ...expectedNames]);
      internal.applyHubRotationEventName(stalledName);
      await collect(adapter, { eventTypes: [...eventTypes] });
      expect(requests.map(request => request.name)).toEqual([...expectedNames, ...expectedNames, ...expectedNames]);
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
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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

  it('cancels between yielded logs before parsing or dispatching the next event', async () => {
    const adapter = adapterAt();
    const contract = new Contract(address, [
      'event ContextGraphExpanded(uint256 contextGraphId, uint256 batchId)',
    ], adapter.getProvider());
    const encoded = contract.interface.encodeEventLog('ContextGraphExpanded', [1n, 2n]);
    const parse = vi.spyOn(contract.interface, 'parseLog');
    const logs = [11, 12].map(blockNumber => ({ ...encoded, blockNumber, transactionHash: `tx-${blockNumber}` }));
    Object.assign(adapter, { contracts: { contextGraphStorage: contract }, readContractWith: async () => logs });
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
