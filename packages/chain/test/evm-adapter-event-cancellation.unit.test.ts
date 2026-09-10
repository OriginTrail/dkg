import { createServer } from 'node:http';
import { Contract } from 'ethers';
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
