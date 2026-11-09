import { afterEach, vi, type Mock } from 'vitest';
import { OxigraphStore, type Quad, type QueryOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../../src/async-lift-publisher-impl.js';
import type { AsyncLiftPublisherConfig, AsyncKnowledgeAssetVmPublishCertifiedResult } from '../../src/async-lift-publisher-types.js';
import {
  DEFAULT_JOURNAL_GRAPH_URI, DEFAULT_WALLET_LOCK_GRAPH_URI, JOURNAL_JOB_ID, JOURNAL_KIND,
} from '../../src/async-lift-control-plane.js';
import { KA_VM_AUTHOR_ADDRESS, KA_VM_EXECUTOR_TX_HASH, KA_VM_KA_UAL } from '../../../../scripts/testing/ka-vm-publish.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

export function gate() {
  let release!: () => void;
  let enter!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { enter = resolve; });
  return { release, reached, wait: async () => { enter(); await held; } };
}

/** Bounded observation returns a value for an assertion; every caller releases its gates in finally. */
export async function completesWithin(work: Promise<unknown>, ms = 500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function observe<T>(promise: Promise<T>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return { promise, settled: () => settled };
}

export interface JournalEntryView { kind: string; jobId: string }
export interface JournalHooks {
  /** Runs before the sequence-allocation read; receives the options the journal passed to the store. */
  read?: (options?: QueryOptions) => Promise<void>;
  /** Runs before the journal insert; receives the options the journal passed to the store. */
  insert?: (entry: JournalEntryView, options?: QueryOptions) => Promise<void>;
  walletWrite?: () => Promise<void>;
}

interface JournalFixture {
  inner: OxigraphStore;
  store: TripleStore;
  create(config?: AsyncLiftPublisherConfig, decorated?: TripleStore): TripleStoreAsyncLiftPublisher;
  decoratedStore(): TripleStore;
  hooks: JournalHooks;
  journalReads: Mock<() => void>;
  journalInserts: JournalEntryView[];
  walletWrites: Mock<() => void>;
  advance(ms: number): void;
}

export function fixture(): JournalFixture {
  const inner = new OxigraphStore();
  stores.push(inner);
  const hooks: JournalHooks = {};
  const journalReads = vi.fn<() => void>();
  const journalInserts: JournalEntryView[] = [];
  const walletWrites = vi.fn<() => void>();
  let now = 1_000;
  let ids = 0;
  let tokens = 0;
  function decoratedStore(): TripleStore {
    return new Proxy(inner, {
      has: (target, key) => key === 'innerStore' || Reflect.has(target, key),
      get(target, key) {
        const delegate: TripleStore = target;
        if (key === 'innerStore') return inner;
        if (key === 'query') return async (query: string, options?: QueryOptions) => {
          if (options?.source === 'publisher.asyncLift.allocateJournalSeq') {
            journalReads();
            await hooks.read?.(options);
          }
          return target.query(query, options);
        };
        if (key === 'insert') return async (quads: Quad[], options?: QueryOptions) => {
          if (quads.some((quad) => quad.graph === DEFAULT_JOURNAL_GRAPH_URI)) {
            const value = (predicate: string): string => JSON.parse(quads.find((quad) => quad.predicate === predicate)!.object) as string;
            const entry = { kind: value(JOURNAL_KIND), jobId: value(JOURNAL_JOB_ID) };
            journalInserts.push(entry);
            await hooks.insert?.(entry, options);
          }
          await delegate.insert(quads, options);
        };
        if (key === 'replaceSubject') return async (graph: string, subject: string, quads: Quad[], options?: QueryOptions) => {
          if (graph === DEFAULT_WALLET_LOCK_GRAPH_URI) {
            await hooks.walletWrite?.();
            await delegate.replaceSubject!(graph, subject, quads, options);
            walletWrites();
            return;
          }
          await delegate.replaceSubject!(graph, subject, quads, options);
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const store = decoratedStore();
  const create = (config: AsyncLiftPublisherConfig = {}, decorated = store) => new TripleStoreAsyncLiftPublisher(decorated, {
    now: () => now, idGenerator: () => `job-${++ids}`, claimTokenGenerator: () => `token-${++tokens}`,
    journalWrites: true, ...config,
  });
  return { inner, store, create, decoratedStore, hooks, journalReads, journalInserts, walletWrites,
    advance: (ms: number) => { now += ms; } };
}

export function completeResult(): AsyncKnowledgeAssetVmPublishCertifiedResult {
  return {
    status: 'confirmed', localFinalizationComplete: true, kaId: 7n, ual: KA_VM_KA_UAL,
    merkleRoot: new Uint8Array(32).fill(0x12), kaManifest: [],
    onChainResult: { txHash: KA_VM_EXECUTOR_TX_HASH, blockNumber: 1, blockTimestamp: 1, batchId: 7n,
      startKAId: 7n, endKAId: 7n, publisherAddress: KA_VM_AUTHOR_ADDRESS },
  };
}
