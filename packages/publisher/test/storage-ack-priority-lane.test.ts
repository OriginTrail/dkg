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
const coreWallet = ethers.Wallet.createRandom();
const fakePeerId = { toString: () => 'publisher-peer' } as any;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

const swmQuads: Quad[] = [
  makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
  makeQuad('urn:entity:1', 'urn:p', 'urn:o2'),
];
const merkleRoot = computeFlatKCRoot(swmQuads, []);
const swmMerkleLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, []);

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

class PriorityLaneStore implements TripleStore {
  readonly queryCancellation = 'interruptible' as const;
  ackQueries = 0;
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
      this.events.push('background:listGraphs:start');
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

  async insert(): Promise<void> {}
  async delete(): Promise<void> {}
  async deleteByPattern(): Promise<number> { return 0; }
  async hasGraph(): Promise<boolean> { return false; }
  async createGraph(): Promise<void> {}
  async dropGraph(): Promise<void> {}
  async deleteBySubjectPrefix(): Promise<number> { return 0; }
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
    expect(events).toEqual(['ack:query:start']);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toBe('ack handler deadline exceeded');
    expect(onDecline).toHaveBeenCalledOnce();
  });
});
