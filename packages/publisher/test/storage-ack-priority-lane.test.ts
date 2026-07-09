import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  decodeStorageACK,
  isStorageACKDecline,
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
} from '@origintrail-official/dkg-core';
import {
  StorePriorityScheduler,
  type QueryOptions,
  type QueryResult,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 as computeFlatKCRoot, computeFlatKCMerkleLeafCountV10 } from '../src/merkle.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { encodePublishIntent } from '@origintrail-official/dkg-core';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const contextGraphId = '42';
const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
const coreWallet = ethers.Wallet.createRandom();
const fakePeerId = { toString: () => 'publisher-peer' } as any;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeQuad(s: string, p: string, o: string, g = swmGraph): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

const swmQuads: Quad[] = [
  makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
  makeQuad('urn:entity:1', 'urn:p', 'urn:o2'),
];
const merkleRoot = computeFlatKCRoot(swmQuads, []);
const swmMerkleLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, []);

function quadsToNQuads(quads: Quad[]): string {
  return quads
    .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`)
    .join('\n');
}

function publishIntent(): Uint8Array {
  return encodePublishIntent({
    merkleRoot,
    contextGraphId,
    publisherPeerId: 'publisher-0',
    publicByteSize: 300,
    isPrivate: false,
    kaCount: 1,
    rootEntities: ['urn:entity:1'],
    epochs: 1,
    tokenAmountStr: '1000',
    merkleLeafCount: swmMerkleLeafCount,
  });
}

function inlineStagingPublishIntent(): Uint8Array {
  const stagingQuads = new TextEncoder().encode(quadsToNQuads(swmQuads));
  return encodePublishIntent({
    merkleRoot,
    contextGraphId,
    publisherPeerId: 'publisher-0',
    publicByteSize: stagingQuads.length,
    isPrivate: false,
    kaCount: 1,
    rootEntities: ['urn:entity:1'],
    epochs: 1,
    tokenAmountStr: '1000',
    merkleLeafCount: swmMerkleLeafCount,
    stagingQuads,
  });
}

type RecordedStoreCall = {
  op: string;
  priority: QueryOptions['priority'] | undefined;
  source: string | undefined;
  signal: AbortSignal | undefined;
};

class PriorityLaneStore implements TripleStore {
  readonly queryCancellation = 'interruptible' as const;
  ackQueries = 0;
  readonly writeCalls: RecordedStoreCall[] = [];
  private releaseBackground!: () => void;
  readonly backgroundGate = new Promise<void>((resolve) => {
    this.releaseBackground = resolve;
  });

  constructor(
    private readonly scheduler: StorePriorityScheduler,
    private readonly events: string[],
    private readonly options: { hangAck?: boolean } = {},
  ) {}

  releaseBackgroundWork(): void {
    this.releaseBackground();
  }

  async query(_sparql: string, options?: QueryOptions): Promise<QueryResult> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.query', async () => {
      this.events.push(`${options?.priority ?? 'normal'}:query:start`);
      if (options?.priority === 'ack') {
        this.ackQueries += 1;
        if (this.options.hangAck) return new Promise<QueryResult>(() => {});
        return { type: 'quads', quads: swmQuads };
      }
      return { type: 'bindings', bindings: [] };
    }, options?.signal);
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.listGraphs', async () => {
      this.events.push(`${options?.priority ?? 'normal'}:listGraphs:start`);
      if (options?.priority === 'ack') return [];
      await this.backgroundGate;
      this.events.push('background:listGraphs:end');
      return [];
    }, options?.signal);
  }

  async countQuads(_graphUri?: string, options?: QueryOptions): Promise<number> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.countQuads', async () => {
      this.events.push('background:countQuads:start');
      return 0;
    }, options?.signal);
  }

  private recordWrite(op: string, options?: QueryOptions): void {
    this.writeCalls.push({
      op,
      priority: options?.priority,
      source: options?.source,
      signal: options?.signal,
    });
  }

  async insert(_quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.insert', async () => {
      this.recordWrite('insert', options);
    }, options?.signal);
  }

  async delete(_quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.delete', async () => {
      this.recordWrite('delete', options);
    }, options?.signal);
  }

  async deleteByPattern(_pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.deleteByPattern', async () => {
      this.recordWrite('deleteByPattern', options);
      return 0;
    }, options?.signal);
  }

  async hasGraph(): Promise<boolean> { return false; }
  async createGraph(): Promise<void> {}

  async dropGraph(_graphUri: string, options?: QueryOptions): Promise<void> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.dropGraph', async () => {
      this.recordWrite('dropGraph', options);
    }, options?.signal);
  }

  async deleteBySubjectPrefix(_graphUri: string, _prefix: string, options?: QueryOptions): Promise<number> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.deleteBySubjectPrefix', async () => {
      this.recordWrite('deleteBySubjectPrefix', options);
      return 0;
    }, options?.signal);
  }

  async flush(options?: QueryOptions): Promise<void> {
    return this.scheduler.run(options?.priority, options?.source ?? 'test.flush', async () => {
      this.recordWrite('flush', options);
    }, options?.signal);
  }

  async close(): Promise<void> {}
}

function createHandler(
  store: TripleStore,
  configOverrides: Partial<StorageACKHandlerConfig> = {},
): StorageACKHandler {
  const config: StorageACKHandlerConfig = {
    nodeRole: 'core',
    nodeIdentityId: 42n,
    signerWallet: coreWallet,
    contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: TEST_CHAIN_ID,
    kav10Address: TEST_KAV10_ADDR,
    isCgCurated: async () => true,
    ...configOverrides,
  };
  return new StorageACKHandler(store, config, new TypedEventBus() as any);
}

describe('StorageACKHandler priority store lane', () => {
  it('completes ACK verification while slow listGraphs/count jobs are queued', async () => {
    const scheduler = new StorePriorityScheduler(2, 1);
    const events: string[] = [];
    const store = new PriorityLaneStore(scheduler, events);

    const listGraphs = store.listGraphs({
      priority: 'background',
      source: 'sync.responder.listGraphs',
    });
    await tick();

    const countQuads = store.countQuads(undefined, {
      priority: 'background',
      source: 'metrics.countQuads',
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      backgroundInflight: 1,
      backgroundQueued: 1,
    });

    const handler = createHandler(store, { ackHandlerDeadlineMs: 1_000 });
    const response = await handler.handler(publishIntent(), fakePeerId);
    const decoded = decodeStorageACK(response);

    expect(isStorageACKDecline(decoded)).toBe(false);
    expect(store.ackQueries).toBe(1);
    expect(events).toEqual([
      'background:listGraphs:start',
      'ack:listGraphs:start',
      'ack:query:start',
    ]);

    store.releaseBackgroundWork();
    await expect(Promise.all([listGraphs, countQuads])).resolves.toEqual([[], 0]);
  });

  it('still declines when the prioritized ACK store operation itself exceeds the deadline', async () => {
    const scheduler = new StorePriorityScheduler(2, 1);
    const events: string[] = [];
    const store = new PriorityLaneStore(scheduler, events, { hangAck: true });
    const onDecline = vi.fn();
    const handler = createHandler(store, { ackHandlerDeadlineMs: 50, onDecline });

    const response = await handler.handler(publishIntent(), fakePeerId);
    const decoded = decodeStorageACK(response);

    expect(store.ackQueries).toBe(1);
    expect(events).toEqual(['ack:listGraphs:start', 'ack:query:start']);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toBe('ack handler deadline exceeded');
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it('passes ACK priority options through inline staging writes and flushes', async () => {
    const scheduler = new StorePriorityScheduler(2, 1);
    const events: string[] = [];
    const store = new PriorityLaneStore(scheduler, events);
    const handler = createHandler(store, { ackHandlerDeadlineMs: 1_000 });

    const response = await handler.handler(inlineStagingPublishIntent(), fakePeerId);
    const decoded = decodeStorageACK(response);

    expect(isStorageACKDecline(decoded)).toBe(false);
    expect(store.ackQueries).toBe(0);
    expect(store.writeCalls.map((call) => call.source)).toEqual([
      'storage-ack.persistStaging.dropGraph',
      'storage-ack.persistStaging.insert',
      'storage-ack.persistStaging.flush',
    ]);
    expect(store.writeCalls.every((call) => call.priority === 'ack')).toBe(true);

    const signals = store.writeCalls.map((call) => call.signal);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0]?.aborted).toBe(false);
  });
});
