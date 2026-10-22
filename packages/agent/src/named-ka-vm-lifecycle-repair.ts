// SPDX-License-Identifier: Apache-2.0
import { isNamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { CoalescingRecurringTask } from './coalescing-recurring-task.js';
import { readFile } from 'node:fs/promises';
import { DurableReplaceableFile } from './durable-file-replace.js';
import { join } from 'node:path';
import { ConfirmedNamedKaVmLifecycleExecutor } from './named-ka-vm-lifecycle-executor.js';
import { lifecycleRepairKey, type LifecycleRepairEntry as RepairEntry } from './named-ka-vm-lifecycle-repair-journal.js';
import { NamedKaVmLifecycleSnapshots } from './named-ka-vm-lifecycle-snapshots.js';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

import { normalizeLifecycleRepairInput, reconcileLifecycleRepairEvidence, type ConfirmedNamedKaVmLifecycleInput, type ValidatedLifecycleRepairCommand } from './named-ka-vm-lifecycle-evidence.js';

export type NamedKaVmLifecycleRepairOutcome = 'repaired' | 'pending' | 'superseded' | 'rejected';

/** A confirmed transaction is never submitted again by this owner: it only repairs local evidence. */
export class NamedKaVmLifecycleRepair {
  private readonly executor: ConfirmedNamedKaVmLifecycleExecutor;
  private entries = new Map<string, RepairEntry>();
  private loaded = false;
  private loadTask?: Promise<void>;
  private journalCertain = false;
  private journalTail: Promise<unknown> = Promise.resolve();
  private inFlight = new Set<Promise<unknown>>();
  private worker?: CoalescingRecurringTask;
  private stopping?: Promise<void>;
  private stopped = false;
  /** Keeps a newly created dataDir ancestry pending until a journal barrier persists it. */
  private journalFile?: DurableReplaceableFile;
  private readonly snapshots?: NamedKaVmLifecycleSnapshots;

  constructor(private readonly options: {
    dataDir?: string;
    now?: () => number;
    /** Share the publisher's lifecycle domain for currency, admission and mutation. */
    writeLocks: Map<string, Promise<void>>;
    /** Resolve after the host's completion policy; stock managed HTTP is acknowledgement-only. */
    apply: (input: ValidatedLifecycleRepairCommand, preserveVerifiedVmProof: boolean) => Promise<void>;
    /** Coherent chain version evidence; a newer chain version fences an old repair. */
    isCurrent: (input: ValidatedLifecycleRepairCommand) => Promise<boolean>;
    warn: (message: string) => void;
  }) {
    this.executor = new ConfirmedNamedKaVmLifecycleExecutor(options);
    if (options.dataDir) this.snapshots = new NamedKaVmLifecycleSnapshots(options.dataDir);
    if (!(options.writeLocks instanceof Map)) throw Object.assign(new Error('Named KA lifecycle repair requires the shared lifecycle write-lock map'), {
      code: 'KA_VM_LIFECYCLE_REPAIR_LOCKS_REQUIRED',
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.journalTail.then(work, work);
    this.journalTail = result.catch(() => undefined);
    return result;
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadTask) return this.loadTask;
    const task = Promise.resolve().then(async () => {
      let entries = this.entries;
      if (this.options.dataDir) {
        let bytes: string | undefined;
        try { bytes = await readFile(join(this.options.dataDir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (bytes !== undefined) entries = await this.snapshots!.decode(JSON.parse(bytes));
        // Includes historical inline migration and fresh-owner ancestry adoption.
        const leases = await this.snapshots!.prepareEntries(entries);
        try { this.entries = entries; this.loaded = true; }
        finally { for (const lease of leases) lease.release(); }
      } else this.loaded = true;
    });
    this.loadTask = task;
    void task.catch(() => { if (this.loadTask === task) this.loadTask = undefined; });
    return task;
  }
  private async persist(): Promise<void> {
    const dir = this.options.dataDir;
    if (!dir) return;
    this.journalFile ??= new DurableReplaceableFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), { fileMode: 0o600, directoryMode: 0o700 });
    try {
      await this.journalFile.replace(JSON.stringify(this.snapshots!.encodePrepared(this.entries)));
      this.journalCertain = true;
    } catch (error) { this.journalCertain = false; this.snapshots!.suspendRetirement(); throw error; }
    this.snapshots!.publishRetained(this.entries);
    this.scheduleCleanup();
  }

  submit(input: ConfirmedNamedKaVmLifecycleInput): Promise<NamedKaVmLifecycleRepairOutcome> {
    if (this.stopped) return Promise.reject(new Error('Named KA lifecycle repair owner is stopped'));
    let resolve!: (value: NamedKaVmLifecycleRepairOutcome) => void, reject!: (reason: unknown) => void;
    const task = new Promise<NamedKaVmLifecycleRepairOutcome>((onSuccess, onFailure) => { resolve = onSuccess; reject = onFailure; });
    // Own the whole submission before input getters or filesystem callbacks can stop us.
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task)).catch(() => {});
    try {
      const stored = normalizeLifecycleRepairInput(input);
      void this.submitPrepared(stored).then(resolve, reject);
    } catch (error) { reject(error); }
    return task;
  }

  private scheduleCleanup(): void {
    void this.snapshots?.cleanup().catch(error => this.options.warn(`Lifecycle snapshot cleanup deferred: ${String(error)}`));
  }

  private async cleanupUnusedPreparation(): Promise<void> {
    await this.serial(async () => { if (this.journalCertain) this.scheduleCleanup(); });
  }

  private async submitPrepared(stored: ValidatedLifecycleRepairCommand): Promise<NamedKaVmLifecycleRepairOutcome> {
    await this.load();
    const key = lifecycleRepairKey(stored);
    // Reject stale/conflicting evidence before preparing an unnecessary immutable file.
    const initial = await this.serial(async () => {
      const evidence = reconcileLifecycleRepairEvidence(this.entries.get(key), stored);
      return evidence.status === 'superseded' ? undefined : evidence.input;
    });
    if (!initial) return 'superseded';
    let selected: ValidatedLifecycleRepairCommand = initial;
    let lease: Awaited<ReturnType<NamedKaVmLifecycleSnapshots['prepare']>> | undefined;
    type Admission = { outcome: NamedKaVmLifecycleRepairOutcome } | { key: string; entry: RepairEntry };
    let admitted: Admission;
    try {
      for (;;) {
        const prepared = selected;
        const nextLease = await this.snapshots?.prepare(prepared.materialization);
        lease?.release(); lease = nextLease;
        const checked = await this.serial<Admission | { prepare: ValidatedLifecycleRepairCommand }>(async () => {
          // An accepted preparation can journal during stop; execution remains fenced.
          const previous = this.entries.get(key), evidence = reconcileLifecycleRepairEvidence(previous, stored);
          if (evidence.status === 'superseded') return { outcome: 'superseded' as const };
          // Retirement or an equivalent concurrent admission may select a different
          // immutable object. Prepare/lease it outside serialization, then recheck.
          if (evidence.input.materialization !== prepared.materialization) return { prepare: evidence.input };
          const entry: RepairEntry = evidence.status === 'unchanged' && previous !== undefined ? previous
            : { input: evidence.input, attempts: 0, nextAttemptAt: this.now() };
          this.entries.set(key, entry);
          try { await this.persist(); }
          catch (error) {
            if (previous) this.entries.set(key, previous); else this.entries.delete(key);
            throw error;
          }
          return { key, entry };
        });
        if ('prepare' in checked) { selected = checked.prepare; continue; }
        admitted = checked; break;
      }
    } catch (error) {
      lease?.release(); await this.cleanupUnusedPreparation(); throw error;
    }
    lease?.release();
    if ('outcome' in admitted) { await this.cleanupUnusedPreparation(); return admitted.outcome; }
    return this.execute(admitted.key, admitted.entry);
  }

  private execute(key: string, entry: RepairEntry): Promise<NamedKaVmLifecycleRepairOutcome> {
    if (entry.retention === 'historical-unbound') return Promise.resolve('pending');
    const input = entry.input;
    const execution = this.executor.withLock(input, async () => {
      // The shared lifecycle owner covers readiness, graph commitment and durable
      // journal retirement. Admissions never wait on this lock inside journal serialization.
      const ready = await this.serial(async () => {
        if (this.entries.get(key) !== entry) return 'superseded' as const;
        if (entry.rejected) return 'rejected' as const;
        if (this.stopped || entry.nextAttemptAt > this.now()) return 'pending' as const;
        return undefined;
      });
      return ready ?? await this.attempt(key, entry);
    });
    this.inFlight.add(execution);
    void execution.finally(() => this.inFlight.delete(execution)).catch(() => undefined);
    return execution;
  }
  private async attempt(key: string, entry: RepairEntry): Promise<NamedKaVmLifecycleRepairOutcome> {
    if (entry.retention === 'historical-unbound') return 'pending';
    const input = entry.input;
    let outcome: NamedKaVmLifecycleRepairOutcome;
    let failure: unknown;
    try {
      // Readiness already ran after the prior lifecycle writer physically retired.
      // Admission can still supersede this entry during the external currency read.
      outcome = await this.executor.commitIfCurrent(input,
        () => this.serial(async () => this.entries.get(key) === entry
          ? { lifecycleAuthor: input.agentAddress, preserveVerifiedVmProof: false } : undefined)) ? 'repaired' : 'superseded';
    } catch (error) {
      failure = error;
      outcome = isNamedKaVmLifecycleIntegrityError(error) ? 'rejected' : 'pending';
    }
    return this.serial(async () => {
      if (this.entries.get(key) !== entry) return 'superseded';
      if (outcome === 'repaired' || outcome === 'superseded') this.entries.delete(key);
      else {
        entry.attempts += 1;
        entry.lastError = failure instanceof Error ? failure.message : String(failure);
        entry.rejected = outcome === 'rejected';
        entry.nextAttemptAt = this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(entry.attempts - 1, 6));
        const pressure = isStoreSchedulerBusyError(failure) || isStoreOperationTimeoutError(failure);
        this.options.warn(`Confirmed named KA ${input.name} lifecycle repair ${outcome}${pressure ? ' under store pressure' : ''}: ${entry.lastError}`);
      }
      try { await this.persist(); }
      catch (error) {
        // Admission already succeeded. Keep the original obligation even if the
        // replacement became visible before its durability barrier failed.
        this.entries.set(key, entry);
        entry.attempts += 1;
        entry.nextAttemptAt = this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(entry.attempts - 1, 6));
        this.options.warn(`Confirmed lifecycle repair settlement remains pending: ${String(error)}`);
        return 'pending';
      }
      return outcome;
    });
  }
  runDue(): Promise<void> {
    const pass = this.runDuePass();
    this.inFlight.add(pass);
    void pass.finally(() => this.inFlight.delete(pass)).catch(() => undefined);
    return pass;
  }
  private async runDuePass(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return;
    await this.load();
    const due = await this.serial(async () => {
      if (this.stopped) return [];
      return [...this.entries].filter(([, entry]) => entry.retention !== 'historical-unbound' && !entry.rejected && entry.nextAttemptAt <= this.now())
        .sort((a, b) => a[1].nextAttemptAt - b[1].nextAttemptAt).slice(0, 10);
    });
    // A held KA must not stall independent assets. The journal and shared KA
    // locks remain the only serialization boundaries; each pass admits at most ten.
    const pending = due.values();
    await Promise.all(Array.from({ length: Math.min(4, due.length) }, async () => {
      for (const [key, entry] of pending) {
        if (this.stopped || signal?.aborted) break;
        await this.execute(key, entry);
      }
    }));
  }
  start(): void {
    if (this.worker !== undefined || this.stopping !== undefined) return;
    this.stopped = false;
    this.worker = new CoalescingRecurringTask({
      retryIntervalMs: 5_000, requestWhileRunning: 'drop',
      runPass: signal => this.runDuePass(signal),
      onError: error => this.options.warn(`Named KA lifecycle repair worker failed: ${String(error)}`),
      closingMessage: 'Named KA lifecycle repair worker stopped',
    });
    this.worker.schedule(5_000);
  }
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopped = true;
    const worker = this.worker;
    this.stopping = (async () => {
      await worker?.close();
      await this.journalTail;
      await Promise.allSettled(this.inFlight);
      await this.journalTail;
      await this.snapshots?.drain();
    })().finally(() => {
      if (this.worker === worker) this.worker = undefined;
      this.stopping = undefined;
    });
    return this.stopping;
  }
  /**
   * Host shutdown fence: stop admission now and await the returned drain later.
   * Scheduled repairs stay journaled for a same-instance restart, including process-local hosts.
   */
  beginStop(): Promise<void> {
    const drain = this.stop();
    void drain.catch(() => {});
    return drain;
  }
}
