import { AsyncLocalStorage } from 'node:async_hooks';
import { findTripleStoreCapability, type TripleStore } from '@origintrail-official/dkg-storage';
import type { AdmissionJournalEntry } from './lift-job.js';
import {
  DEFAULT_JOURNAL_GRAPH_URI, JOURNAL_LIFECYCLE_KEY, JOURNAL_SEQ,
  literal, parseIntegerLiteral, serializeJournalEntry,
} from './async-lift-control-plane.js';
import { expectBindings } from './async-lift-publisher-utils.js';
import { withKeyedLocks } from './keyed-lock.js';

type CapturedJournalFacts = Readonly<Omit<AdmissionJournalEntry, 'seq' | 'at'>>;

interface CompletionOwner {
  open: boolean;
  readonly pending: Set<Promise<void>>;
}
interface CanonicalSection {
  open: boolean;
  succeeded: boolean;
  readonly released: Promise<void>;
}
const operationBrand: unique symbol = Symbol('journal operation');
const sectionBrand: unique symbol = Symbol('journal canonical section');

/** Internal authority: always created at an independently awaited API/worker boundary. */
export interface JournalOperation {
  readonly [operationBrand]: true;
  runCanonical<T>(work: (section: JournalSection) => Promise<T>): Promise<T>;
}

/** Captured by commit closures; never inferred from the caller's async context. */
export interface JournalSection {
  readonly [sectionBrand]: true;
  assertOpen(): void;
  append(facts: CapturedJournalFacts, afterAttempt: () => void): JournalRegistration;
  joinJob(jobId: string, after?: () => void): JournalRegistration;
  afterSuccessfulJobSettlement(jobId: string, observe: () => void): void;
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
  // Reserve under canonical ownership, but dispatch after release; journal work never acquires it.
  private static readonly lineageQueues = new Map<string, Promise<void>>();
  // Node propagates every enabled AsyncLocalStorage on each async resource.
  // One per publisher accumulates hooks across restarts, even after settlement.
  // Keep one context resource, with instance-scoped owners for nested calls.
  private static readonly context = new AsyncLocalStorage<ReadonlyMap<AsyncLiftJournalCompletion, CompletionOwner>>();
  private readonly identity: object;

  constructor(
    private readonly store: TripleStore,
    private readonly graphUri: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.identity = findTripleStoreCapability(store, (candidate): candidate is object =>
      typeof candidate === 'object' && candidate !== null && !('innerStore' in candidate)) ?? store;
  }

  /** An independently awaited API or worker lifecycle, including reentrant public calls. */
  runPublicOperation<T>(work: (operation: JournalOperation) => Promise<T>): Promise<T> {
    const owner: CompletionOwner = { open: true, pending: new Set() };
    const queue = this.queue();
    let release!: () => void;
    const finished = new Promise<void>((resolve) => { release = resolve; });
    queue.owners.add(finished);
    // Invoke work synchronously: the canonical lock must reserve its place before we yield.
    const owners = new Map(AsyncLiftJournalCompletion.context.getStore());
    owners.set(this, owner);
    return AsyncLiftJournalCompletion.context.run(owners, async () => {
      try {
        return await work({ [operationBrand]: true, runCanonical: (work) => this.runCanonical(owner, work) });
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

  private runCanonical<T>(owner: CompletionOwner, work: (section: JournalSection) => Promise<T>): Promise<T> {
    this.assertOwnerOpen(owner);
    let release!: () => void;
    const state: CanonicalSection = {
      open: true, succeeded: false, released: new Promise<void>((resolve) => { release = resolve; }),
    };
    const assertOpen = (): void => {
      this.assertOwnerOpen(owner);
      if (!state.open) throw new Error('Publisher canonical section is closed');
    };
    const section: JournalSection = {
      [sectionBrand]: true, assertOpen,
      append: (facts, after) => { assertOpen(); return this.append(owner, state, facts, after); },
      joinJob: (jobId, after) => { assertOpen(); return this.registerJobJoin(owner, jobId, after); },
      afterSuccessfulJobSettlement: (jobId, observe) => {
        assertOpen();
        const completion = this.existingQueue()?.jobs.get(jobId);
        void Promise.all([state.released, completion]).then(() => {
          if (state.succeeded) try { observe(); } catch { /* Diagnostics cannot change settlement. */ }
        });
      },
    };
    return (async () => {
      try {
        const result = await work(section);
        state.succeeded = true;
        return result;
      } finally {
        // The outer lock helper has already released all nested canonical locks.
        state.open = false;
        release();
      }
    })();
  }

  private assertOwnerOpen(owner: CompletionOwner): void {
    if (!owner.open) throw new Error('Publisher completion operation is closed');
  }

  /** Reserve the append now; dispatch its store work only after canonical release. */
  private append(owner: CompletionOwner, section: CanonicalSection, facts: CapturedJournalFacts, afterAttempt: () => void): JournalRegistration {
    const jobId = facts.jobId;
    // This call installs the lineage gate synchronously, before its first await.
    const started = this.appendToLineage(facts, section.released)
      .catch(() => { /* Auxiliary journal failure must not abort the authoritative write. */ })
      .then(afterAttempt);
    const queue = this.queue();
    const predecessor = queue.jobs.get(jobId);
    // A later journal's settlement includes earlier bookkeeping, not merely its FIFO insert.
    const completion = Promise.all([predecessor, started.catch(() => {})]).then(() => {});
    owner.pending.add(completion);
    queue.jobs.set(jobId, completion);
    void completion.then(() => {
      if (queue.jobs.get(jobId) === completion) queue.jobs.delete(jobId);
      this.prune(queue);
    });
    return { settled: completion };
  }

  /**
   * #1829 — reserve sequence allocation and INSERT in primary-commit order. Wait for canonical
   * release without acquiring claim/job ownership; distinct lineages append in parallel.
   */
  private async appendToLineage(facts: CapturedJournalFacts, released: Promise<void>): Promise<void> {
    const captured = { ...facts };
    // The journal graph is fixed; preserve the existing process-wide lineage-only FIFO domain.
    // The canonical primitive releases FIFO before notification bookkeeping in append().
    return withKeyedLocks(AsyncLiftJournalCompletion.lineageQueues, [captured.lineageKey], async () => {
      await released;
      const seq = await this.allocateSequence(captured.lineageKey);
      const entry = { ...captured, seq, at: this.now() };
      await this.store.insert(serializeJournalEntry(entry, DEFAULT_JOURNAL_GRAPH_URI), { source: 'publisher.asyncLift.appendJournalEntry' });
    });
  }

  /** Numeric MAX+1 with the original legacy parser; an empty lineage starts at zero. */
  private async allocateSequence(lineageKey: string): Promise<number> {
    const result = await this.store.query(
      `SELECT (MAX(?seq) AS ?m) WHERE { GRAPH <${DEFAULT_JOURNAL_GRAPH_URI}> { ?e <${JOURNAL_LIFECYCLE_KEY}> ${literal(lineageKey)} ; <${JOURNAL_SEQ}> ?seq } }`,
      { source: 'publisher.asyncLift.allocateJournalSeq' },
    );
    const rows = expectBindings(result);
    const raw = rows.length === 0 ? undefined : rows[0]?.['m'];
    if (raw === undefined) return 0;
    return parseIntegerLiteral(raw) + 1;
  }

  /** Join only the captured predecessor, never another API's result or a changing future tail. */
  private registerJobJoin(owner: CompletionOwner, jobId: string, after?: () => void): JournalRegistration {
    const predecessor = this.existingQueue()?.jobs.get(jobId);
    if (!predecessor) { after?.(); return { settled: Promise.resolve() }; }
    const settled = predecessor.then(() => { after?.(); }).catch(() => {});
    owner.pending.add(settled);
    return { settled };
  }

  async drain(): Promise<void> {
    // The runner invokes this outside operation ownership, after stopping its producers.
    if (AsyncLiftJournalCompletion.context.getStore()?.get(this)?.open) throw new Error('Cannot drain publisher journals from an active publisher operation');
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
