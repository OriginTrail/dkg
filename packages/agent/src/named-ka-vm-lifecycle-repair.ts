// SPDX-License-Identifier: Apache-2.0
import { NamedKaVmLifecycleIntegrityError, isNamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { CoalescingRecurringTask } from './coalescing-recurring-task.js';
import { readFile } from 'node:fs/promises';
import { replaceDurableFile } from './durable-file-replace.js';
import { join } from 'node:path';
import type { PublishedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle.js';
import { assertionLifecycleWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { decodeLifecycleRepairJournal, encodeLifecycleRepairJournal, lifecycleRepairKey, normalizeLifecycleRepairInput, type LifecycleRepairEntry as RepairEntry } from './named-ka-vm-lifecycle-repair-journal.js';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

export interface ConfirmedNamedKaVmPublicationDeployment {
  readonly chainId: string;
  readonly lifecycleAddress: string;
}
export interface ConfirmedNamedKaVmLifecycleInput extends PublishedNamedKaVmLifecycleInput {
  readonly assertionVersion: string;
  /** Bound by the admitted publication seal; absent only on historical/unbound or no-chain inputs. */
  readonly publicationDeployment?: ConfirmedNamedKaVmPublicationDeployment;
  readonly priorMerkleRoot?: string;
}
export type NamedKaVmLifecycleRepairOutcome = 'repaired' | 'pending' | 'superseded' | 'rejected';

/** A confirmed transaction is never submitted again by this owner: it only repairs local evidence. */
export class NamedKaVmLifecycleRepair {
  private entries = new Map<string, RepairEntry>();
  private loaded = false;
  private journalTail: Promise<unknown> = Promise.resolve();
  private inFlight = new Set<Promise<unknown>>();
  private worker?: CoalescingRecurringTask;
  private stopping?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: {
    dataDir?: string;
    now?: () => number;
    /** Share the publisher's lifecycle domain for currency, admission and mutation. */
    writeLocks: Map<string, Promise<void>>;
    /** Resolve after the host's certified commit barrier: durable for every filesystem journal. */
    apply: (input: ConfirmedNamedKaVmLifecycleInput) => Promise<void>;
    /** Coherent chain version evidence; a newer chain version fences an old repair. */
    isCurrent: (input: ConfirmedNamedKaVmLifecycleInput) => Promise<boolean>;
    warn: (message: string) => void;
  }) {
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
  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.options.dataDir) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.options.dataDir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
        this.entries = decodeLifecycleRepairJournal(parsed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.loaded = true;
  }
  private async persist(): Promise<void> {
    const dir = this.options.dataDir;
    if (!dir) return;
    await replaceDurableFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'),
      JSON.stringify(encodeLifecycleRepairJournal(this.entries)), { fileMode: 0o600, directoryMode: 0o700 });
  }

  async submit(input: ConfirmedNamedKaVmLifecycleInput, options?: { deferExecution?: boolean }): Promise<NamedKaVmLifecycleRepairOutcome> {
    const admitted = await this.serial<{ outcome: NamedKaVmLifecycleRepairOutcome } | { key: string; entry: RepairEntry }>(async () => {
      if (this.stopped) throw new Error('Named KA lifecycle repair owner is stopped');
      await this.load();
      const stored = normalizeLifecycleRepairInput(input);
      const key = lifecycleRepairKey(stored);
      const previous = this.entries.get(key);
      if (previous && BigInt(previous.input.assertionVersion) > BigInt(stored.assertionVersion)) return { outcome: 'superseded' as const };
      if (previous && previous.input.assertionVersion === stored.assertionVersion && previous.input.merkleRoot !== stored.merkleRoot) {
        throw new NamedKaVmLifecycleIntegrityError('Conflicting confirmed roots at the same assertion version');
      }
      const entry = previous?.input.assertionVersion === stored.assertionVersion
        ? previous : { input: stored, attempts: 0, nextAttemptAt: this.now() };
      this.entries.set(key, entry);
      // Write-ahead admission contains no external chain or graph-store work.
      try { await this.persist(); }
      catch (error) {
        if (previous) this.entries.set(key, previous); else this.entries.delete(key);
        throw error;
      }
      return { key, entry };
    });
    if ('outcome' in admitted) return admitted.outcome;
    // A replacement may be holding its lifecycle lock across curator confirmation.
    // Admit the same durable command without making the completed chain call wait
    // on that network; the recurring owner still takes the canonical lock on replay.
    if (options?.deferExecution) { this.start(); return 'pending'; }
    return this.execute(admitted.key, admitted.entry);
  }

  private execute(key: string, entry: RepairEntry): Promise<NamedKaVmLifecycleRepairOutcome> {
    const input = entry.input;
    const execution = withKeyedLocks(this.options.writeLocks, [
      assertionLifecycleWriteLockKey(input.contextGraphId, input.name, input.agentAddress, input.subGraphName),
    ], async () => {
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
    const input = entry.input;
    let outcome: NamedKaVmLifecycleRepairOutcome;
    let failure: unknown;
    try {
      // Readiness already ran after the prior lifecycle writer physically retired.
      // Admission can still supersede this entry during the external currency read.
      if (!await this.options.isCurrent(input)
        || !await this.serial(async () => this.entries.get(key) === entry)) outcome = 'superseded';
      else {
        await this.options.apply(input);
        outcome = 'repaired';
      }
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
      catch (error) { this.entries.set(key, entry); throw error; }
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
    const due = await this.serial(async () => {
      if (this.stopped) return [];
      await this.load();
      return [...this.entries].filter(([, entry]) => !entry.rejected && entry.nextAttemptAt <= this.now())
        .sort((a, b) => a[1].nextAttemptAt - b[1].nextAttemptAt).slice(0, 10);
    });
    for (const [key, entry] of due) {
      if (this.stopped || signal?.aborted) break;
      await this.execute(key, entry);
    }
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
    })().finally(() => {
      if (this.worker === worker) this.worker = undefined;
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
