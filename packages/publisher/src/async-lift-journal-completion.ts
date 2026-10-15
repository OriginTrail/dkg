import { AsyncLocalStorage } from 'node:async_hooks';
import { findTripleStoreCapability, type TripleStore } from '@origintrail-official/dkg-storage';

interface CompletionOwner {
  open: boolean;
  readonly pending: Set<Promise<void>>;
}
interface CanonicalSection {
  open: boolean;
  succeeded: boolean;
  readonly released: Promise<void>;
}
interface CompletionContext {
  readonly owner: CompletionOwner;
  readonly section?: CanonicalSection;
}
interface QueueCompletions {
  readonly owners: Set<Promise<void>>;
  readonly jobs: Map<string, Promise<void>>;
}

/** Registration is synchronous; this promise describes the actual captured auxiliary tail. */
interface JournalRegistration {
  readonly settled: Promise<void>;
}

/** Await auxiliary journals at operation settlement, never while retaining canonical locks. */
export class AsyncLiftJournalCompletion {
  private static readonly domains = new WeakMap<object, Map<string, QueueCompletions>>();
  private readonly context = new AsyncLocalStorage<CompletionContext>();
  private readonly identity: object;

  constructor(store: TripleStore, private readonly graphUri: string) {
    this.identity = findTripleStoreCapability(store, (candidate): candidate is object =>
      typeof candidate === 'object' && candidate !== null && !('innerStore' in candidate)) ?? store;
  }

  /** An independently awaited API or worker lifecycle, including reentrant public calls. */
  runPublicOperation<T>(work: () => Promise<T>): Promise<T> {
    const owner: CompletionOwner = { open: true, pending: new Set() };
    const queue = this.queue();
    let release!: () => void;
    const finished = new Promise<void>((resolve) => { release = resolve; });
    queue.owners.add(finished);
    // Invoke work synchronously: the canonical lock must reserve its place before we yield.
    return this.context.run({ owner }, async () => {
      try {
        return await work();
      } finally {
        owner.open = false;
        try {
          await Promise.all(owner.pending);
        } finally {
          queue.owners.delete(finished);
          release();
          this.prune(queue);
        }
      }
    });
  }

  /** Observe this job's captured tail and successful canonical release, not its owner's other jobs. */
  afterSuccessfulJobSettlement(jobId: string, observe: () => void): void {
    const section = this.context.getStore()?.section;
    if (!section?.open) return;
    const completion = this.existingQueue()?.jobs.get(jobId);
    void Promise.all([section.released, completion]).then(() => {
      if (section.succeeded) try { observe(); } catch { /* Diagnostics cannot change settlement. */ }
    });
  }

  runCriticalSection<T>(work: () => Promise<T>): Promise<T> {
    const context = this.context.getStore();
    if (!context?.owner.open) return this.runPublicOperation(() => this.runCriticalSection(work));
    if (context.section?.open) return work();
    let release!: () => void;
    const section: CanonicalSection = {
      open: true, succeeded: false, released: new Promise<void>((resolve) => { release = resolve; }),
    };
    return this.context.run({ ...context, section }, async () => {
      try {
        const result = await work();
        section.succeeded = true;
        return result;
      } finally {
        // The lock helper has already run its release finally, including all nested job locks.
        section.open = false;
        release();
      }
    });
  }

  /** start must synchronously reserve its lineage FIFO; only its store body awaits released. */
  registerJournal(jobId: string, start: (released: Promise<void>) => Promise<void>): JournalRegistration {
    const context = this.registrationContext();
    let started: Promise<void>;
    try { started = start(context.section?.released ?? Promise.resolve()); }
    catch { started = Promise.resolve(); } // Auxiliary observers cannot poison operation settlement.
    const queue = this.queue();
    const predecessor = queue.jobs.get(jobId);
    // A later journal's settlement includes earlier bookkeeping, not merely its FIFO insert.
    const completion = Promise.all([predecessor, started.catch(() => {})]).then(() => {});
    context.owner.pending.add(completion);
    queue.jobs.set(jobId, completion);
    void completion.then(() => {
      if (queue.jobs.get(jobId) === completion) queue.jobs.delete(jobId);
      this.prune(queue);
    });
    return { settled: completion };
  }

  /** Join only the captured predecessor, never another API's result or a changing future tail. */
  registerJobJoin(jobId: string, after?: () => void): JournalRegistration {
    const context = this.registrationContext();
    const predecessor = this.existingQueue()?.jobs.get(jobId);
    if (!predecessor) { after?.(); return { settled: Promise.resolve() }; }
    const settled = predecessor.then(() => { after?.(); }).catch(() => {});
    context.owner.pending.add(settled);
    return { settled };
  }

  private registrationContext(): CompletionContext {
    const context = this.context.getStore();
    if (!context?.owner.open) throw new Error('Journal registration requires an open publisher completion scope');
    return context;
  }

  async drain(): Promise<void> {
    // The runner invokes this outside operation ownership, after stopping its producers.
    if (this.context.getStore()?.owner.open) throw new Error('Cannot drain publisher journals from an active publisher operation');
    for (;;) {
      const queue = this.existingQueue();
      if (!queue || (queue.owners.size === 0 && queue.jobs.size === 0)) return;
      await Promise.all([...queue.owners, ...queue.jobs.values()]);
    }
  }

  private existingQueue(): QueueCompletions | undefined {
    return AsyncLiftJournalCompletion.domains.get(this.identity)?.get(this.graphUri);
  }

  private queue(): QueueCompletions {
    let domains = AsyncLiftJournalCompletion.domains.get(this.identity);
    if (!domains) {
      domains = new Map();
      AsyncLiftJournalCompletion.domains.set(this.identity, domains);
    }
    let queue = domains.get(this.graphUri);
    if (!queue) {
      queue = { owners: new Set(), jobs: new Map() };
      domains.set(this.graphUri, queue);
    }
    return queue;
  }

  private prune(queue: QueueCompletions): void {
    if (queue.owners.size !== 0 || queue.jobs.size !== 0) return;
    const domains = AsyncLiftJournalCompletion.domains.get(this.identity);
    if (domains?.get(this.graphUri) === queue) domains.delete(this.graphUri);
    if (domains?.size === 0) AsyncLiftJournalCompletion.domains.delete(this.identity);
  }
}
