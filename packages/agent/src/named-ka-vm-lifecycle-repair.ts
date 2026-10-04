// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { replaceDurableFile } from './durable-file-replace.js';
import { join } from 'node:path';
import type { PublishedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle.js';
import { withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { decodeLifecycleRepairJournal, lifecycleRepairKey, normalizeLifecycleRepairInput, type LifecycleRepairEntry as RepairEntry } from './named-ka-vm-lifecycle-repair-journal.js';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

export interface ConfirmedNamedKaVmLifecycleInput extends PublishedNamedKaVmLifecycleInput {
  readonly assertionVersion: string;
  readonly priorMerkleRoot?: string;
}
export type NamedKaVmLifecycleRepairOutcome = 'repaired' | 'pending' | 'superseded' | 'rejected';

/** A confirmed transaction is never submitted again by this owner: it only repairs local evidence. */
export class NamedKaVmLifecycleRepair {
  private entries = new Map<string, RepairEntry>();
  private loaded = false;
  private journalTail: Promise<unknown> = Promise.resolve();
  private executionLocks = new Map<string, Promise<void>>();
  private inFlight = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private workerPending = false;

  constructor(private readonly options: {
    dataDir?: string;
    now?: () => number;
    apply: (input: ConfirmedNamedKaVmLifecycleInput) => Promise<void>;
    /** Coherent chain version evidence; a newer chain version fences an old repair. */
    isCurrent: (input: ConfirmedNamedKaVmLifecycleInput) => Promise<boolean>;
    warn: (message: string) => void;
  }) {}

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
      JSON.stringify({ version: 1, entries: [...this.entries] }), { fileMode: 0o600, directoryMode: 0o700 });
  }

  async submit(input: ConfirmedNamedKaVmLifecycleInput): Promise<NamedKaVmLifecycleRepairOutcome> {
    const admitted = await this.serial<{ outcome: NamedKaVmLifecycleRepairOutcome } | { key: string; entry: RepairEntry }>(async () => {
      if (this.stopped) throw new Error('Named KA lifecycle repair owner is stopped');
      await this.load();
      const stored = normalizeLifecycleRepairInput(input, true);
      const key = lifecycleRepairKey(stored);
      const previous = this.entries.get(key);
      if (previous && BigInt(previous.input.assertionVersion) > BigInt(stored.assertionVersion)) return { outcome: 'superseded' as const };
      if (previous && previous.input.assertionVersion === stored.assertionVersion && previous.input.merkleRoot !== stored.merkleRoot) {
        throw Object.assign(new Error('Conflicting confirmed roots at the same assertion version'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
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
    return this.execute(admitted.key, admitted.entry);
  }

  private execute(key: string, entry: RepairEntry): Promise<NamedKaVmLifecycleRepairOutcome> {
    const execution = withKeyedLocks(this.executionLocks, [key], async () => {
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
    const { packedKaId, ...fields } = entry.input;
    const input: ConfirmedNamedKaVmLifecycleInput = { ...fields,
      ...(packedKaId === undefined ? {} : { packedKaId: BigInt(packedKaId) }) };
    let outcome: NamedKaVmLifecycleRepairOutcome;
    let failure: unknown;
    try {
      if (!await this.options.isCurrent(input)) outcome = 'superseded';
      else {
        // A newer admission may arrive during the chain read. Fence it before applying.
        if (!await this.serial(async () => this.entries.get(key) === entry)) return 'superseded';
        await this.options.apply(input);
        outcome = 'repaired';
      }
    } catch (error) {
      failure = error;
      outcome = (error as { code?: string })?.code === 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' ? 'rejected' : 'pending';
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
  async runDue(): Promise<void> {
    const due = await this.serial(async () => {
      if (this.stopped) return [];
      await this.load();
      return [...this.entries].filter(([, entry]) => !entry.rejected && entry.nextAttemptAt <= this.now())
        .sort((a, b) => a[1].nextAttemptAt - b[1].nextAttemptAt).slice(0, 10);
    });
    for (const [key, entry] of due) {
      if (this.stopped) break;
      await this.execute(key, entry);
    }
  }
  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.workerPending) return;
      this.workerPending = true;
      void this.runDue().catch(error => this.options.warn(`Named KA lifecycle repair worker failed: ${String(error)}`))
        .finally(() => { this.workerPending = false; });
    }, 5_000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.journalTail;
    await Promise.allSettled(this.inFlight);
    await this.journalTail;
  }
}
