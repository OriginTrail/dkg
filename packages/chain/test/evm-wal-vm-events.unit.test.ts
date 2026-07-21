// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ethers, Interface } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const ROOT = `0x${'22'.repeat(32)}`;
const TX_HASH = `0x${'33'.repeat(32)}`;
const BLOCK_HASH = `0x${'44'.repeat(32)}`;

function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  };
}

function encodedLog(
  iface: Interface,
  eventName: string,
  values: readonly unknown[],
  overrides: Record<string, unknown> = {},
) {
  const encoded = iface.encodeEventLog(iface.getEvent(eventName)!, values);
  return {
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 101,
    transactionHash: TX_HASH,
    transactionIndex: 7,
    index: 9,
    blockHash: BLOCK_HASH,
    ...overrides,
  };
}

function adapterFor(
  iface: Interface,
  logsByLabel: Readonly<Record<string, readonly unknown[]>>,
) {
  const adapter: any = new EVMChainAdapter(minimalConfig());
  adapter.initialized = true;
  adapter.init = async () => {};
  adapter.contracts.knowledgeAssetStorage = {
    interface: iface,
    filters: {
      KnowledgeAssetCreated: () => 'created-filter',
      KnowledgeAssetsMinted: () => 'minted-filter',
      KnowledgeAssetUpdated: () => 'updated-filter',
      Transfer: () => 'transfer-filter',
    },
  };
  adapter.readContractWith = async (
    _contract: unknown,
    label: string,
  ) => [...(logsByLabel[label] ?? [])];
  return adapter as EVMChainAdapter;
}

async function collectEvents(
  adapter: EVMChainAdapter,
  eventType: string,
) {
  const events = [];
  for await (const event of adapter.listenForEvents({
    eventTypes: [eventType],
    fromBlock: 100,
    toBlock: 110,
  })) {
    events.push(event);
  }
  return events;
}

describe('WAL VM chain-event extraction', () => {
  it('carries the complete publish ordering and block identity into KCCreated', async () => {
    const iface = new Interface([
      'event KnowledgeAssetCreated(uint256 indexed id, address indexed author, string operationId, bytes32 merkleRoot, uint88 byteSize, uint40 epochs, uint40 tokenAmount, uint96 publisherNodeId, bool immutable_)',
      'event KnowledgeAssetsMinted(uint256 indexed batchId, address indexed to, uint256 startId, uint256 endId)',
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ]);
    const createLog = encodedLog(iface, 'KnowledgeAssetCreated', [
      42n,
      AUTHOR,
      'publish-operation',
      ROOT,
      123n,
      1n,
      2n,
      3n,
      false,
    ]);
    const adapter = adapterFor(iface, {
      'kas.queryFilter(KnowledgeAssetCreated)': [createLog],
      'kas.queryFilter(KnowledgeAssetsMinted)': [],
      'kas.queryFilter(Transfer)': [],
    });

    const events = await collectEvents(adapter, 'KCCreated');

    expect(events).toEqual([{
      type: 'KCCreated',
      blockNumber: 101,
      data: expect.objectContaining({
        kaId: '42',
        author: AUTHOR,
        merkleRoot: ROOT,
        txHash: TX_HASH,
        txIndex: 7,
        logIndex: 9,
        blockHash: BLOCK_HASH,
      }),
    }]);
  });

  it('extracts update author, root, ordering, and block identity', async () => {
    const iface = new Interface([
      'event KnowledgeAssetUpdated(uint256 indexed id, address indexed author, string updateOperationId, bytes32 merkleRoot, uint256 byteSize, uint96 tokenAmount)',
    ]);
    const updateLog = encodedLog(iface, 'KnowledgeAssetUpdated', [
      42n,
      AUTHOR,
      'update-operation',
      ROOT,
      456n,
      7n,
    ]);
    const adapter = adapterFor(iface, {
      'kas.queryFilter(KnowledgeAssetUpdated)': [updateLog],
    });

    const events = await collectEvents(adapter, 'KnowledgeAssetUpdated');

    expect(events).toEqual([{
      type: 'KnowledgeAssetUpdated',
      blockNumber: 101,
      data: {
        kaId: '42',
        author: AUTHOR,
        merkleRoot: ROOT,
        txHash: TX_HASH,
        txIndex: 7,
        logIndex: 9,
        blockHash: BLOCK_HASH,
      },
    }]);
  });
});
