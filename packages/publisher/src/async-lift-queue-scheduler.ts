import { findTripleStoreCapability, type TripleStore } from '@origintrail-official/dkg-storage';
import type { AsyncLiftPublisher } from './async-lift-publisher-types.js';

type Scheduler = Parameters<NonNullable<AsyncLiftPublisher['reconciliationScheduling']>['attachScheduler']>[0];
interface Attachment { readonly scheduler: Scheduler }

/** One scheduling owner per in-process queue, shared by admission and runtime publishers. */
export class AsyncLiftQueueScheduler {
  private static readonly owners = new WeakMap<object, Map<string, Attachment>>();
  private readonly identity: object;

  constructor(store: TripleStore, private readonly graphUri: string) {
    // Follow only the documented decorator accessor. Independent connections/processes still
    // rely on polling; neither endpoint names nor graph names alone establish store identity.
    this.identity = findTripleStoreCapability(store, (candidate): candidate is object =>
      typeof candidate === 'object' && candidate !== null && !('innerStore' in candidate)) ?? store;
  }

  attach(scheduler: Scheduler): () => void {
    let queues = AsyncLiftQueueScheduler.owners.get(this.identity);
    if (!queues) {
      queues = new Map();
      AsyncLiftQueueScheduler.owners.set(this.identity, queues);
    }
    const attachment = { scheduler };
    queues.set(this.graphUri, attachment);
    return () => {
      if (queues.get(this.graphUri) !== attachment) return;
      queues.delete(this.graphUri);
      if (queues.size === 0) AsyncLiftQueueScheduler.owners.delete(this.identity);
    };
  }

  reconciliationDemand(): void {
    try { this.scheduler?.onReconciliationDemand(); } catch { /* Scheduling hints cannot change job outcomes. */ }
  }

  walletRelease(walletId: string): void {
    try { this.scheduler?.onWalletRelease(walletId); } catch { /* Durable ownership remains authoritative. */ }
  }

  workAvailable(): void {
    try { this.scheduler?.onWorkAvailable?.(); } catch { /* A failed observer cannot undo accepted work. */ }
  }

  private get scheduler(): Scheduler | undefined {
    // Lookups never allocate entries: short-lived admission publishers retain no global state.
    return AsyncLiftQueueScheduler.owners.get(this.identity)?.get(this.graphUri)?.scheduler;
  }
}
