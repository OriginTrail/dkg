// SPDX-License-Identifier: Apache-2.0
import { ethers, type JsonRpcProvider } from 'ethers';
import { vi } from 'vitest';
import { ChainEventDecoderRegistry } from '../../src/chain-index/chain-event-decoders.js';
import { chainIndexAuthorityAnchorHolds, resolveChainIndexAuthorityAnchor } from '../../src/chain-index/chain-index-anchor.js';
import { createChainIndexAuthorityPageSource } from '../../src/chain-index/chain-index-authority-page.js';
import { ContextGraphAuthorityIndex } from '../../src/context-graph-authority-index.js';
import { createEvmContextGraphAuthorityIndexRevisionReaderV1 } from '../../src/evm-context-graph-authority-index-reader.js';
import { loadAbi } from '../../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './chain-event-log.js';
import { MemoryAuthorityIndexStore } from './context-graph-authority-index.js';

/** Real reader, reducer and retained projection backed by a completed local log tick. */
export function retainedAuthorityReaderFixture() {
  const storage = `0x${'cd'.repeat(20)}`;
  const deployment = 'evm:31337:0xhub';
  const scope = `${deployment}:${storage}`;
  const now = Date.now();
  const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
  const abi = new ethers.Interface(loadAbi('ContextGraphStorage'));
  const presentNameHash = ethers.keccak256(ethers.toUtf8Bytes('retained-registered-graph'));
  const event = abi.encodeEventLog(abi.getEvent('ContextGraphCreated')!, [
    7n, `0x${'11'.repeat(20)}`, presentNameHash, [`0x${'11'.repeat(20)}`],
    `0x${'44'.repeat(32)}`, 1, 0, `0x${'66'.repeat(20)}`, 7n,
  ]);
  const store = new MemoryChainEventLogStore();
  store.seed(scope, {
    cursor: {
      revision: 1, lineage: hash(1), deploymentBlockNumber: 10,
      settledBlockNumber: 55, settledBlockHash: hash(55),
      head: { number: 105, hash: hash(105), timestampSeconds: Math.floor(now / 1000), fetchedAtMs: now },
      topicSetVersion: 'v1',
    },
    coverage: [{ family: 'context-graph-authority', address: storage, coveredFromBlock: 10, coveredThroughBlock: 105, floorBlock: 10 }],
  }, [{ blockNumber: 20, blockHash: hash(20), logIndex: 0, transactionHash: hash(170), address: storage,
    topics: [...event.topics], data: event.data, settled: true }]);
  const source = {
    contractAddress: storage,
    pageSource: createChainIndexAuthorityPageSource({
      scope, store, registry: new ChainEventDecoderRegistry().registerContextGraphAuthority(storage, abi),
      contractAddress: storage, readBlockHash: async () => null,
    }),
    resolveAnchor: async (input: { deploymentBlockNumber: number; finalityConfirmations: number }) => resolveChainIndexAuthorityAnchor({
      state: await store.load(scope), contractAddress: storage,
      deploymentBlockNumber: input.deploymentBlockNumber, finalityConfirmations: input.finalityConfirmations,
      nowMs: now, maxHeadAgeMs: 18000, headTimestampToleranceMs: 300000,
    }),
    anchorHolds: (anchor: Parameters<typeof chainIndexAuthorityAnchorHolds>[1]) => chainIndexAuthorityAnchorHolds(
      () => store.load(scope), anchor, { nowMs: now, maxHeadAgeMs: 18000, headTimestampToleranceMs: 300000 },
    ),
  };
  // The cold projection discovers chain identity once. Every later physical
  // provider call is counted; block/log reads remain unavailable.
  const providerRead = vi.fn(async (method: string) => {
    if (method === 'network') return { chainId: 31337n };
    throw new Error('retained projection unexpectedly reached provider');
  });
  const provider = {
    getBlock: () => providerRead('block'), getLogs: () => providerRead('logs'),
    getNetwork: () => providerRead('network'),
  } as unknown as JsonRpcProvider;
  const index = new ContextGraphAuthorityIndex(new MemoryAuthorityIndexStore(), undefined, { tickMs: 6000, now: () => now });
  const reader = createEvmContextGraphAuthorityIndexRevisionReaderV1({
    index, deploymentId: deployment, initialize: async () => undefined,
    requireContextGraphStorage: () => new ethers.Contract(storage, abi),
    readTipProvider: async (_label, read) => read(provider),
    resolveContractDeployBlockNumber: async () => 10,
    pageSize: () => 2000, finalityConfirmations: () => 1, chainEventLogAuthority: () => source,
  });
  reader.snapshots.open();
  return { reader, providerRead, presentNameHash, index };
}
