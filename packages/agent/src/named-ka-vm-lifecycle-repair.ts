// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublishedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle.js';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

export interface ConfirmedNamedKaVmLifecycleInput extends PublishedNamedKaVmLifecycleInput {
  readonly assertionVersion: string;
  readonly priorMerkleRoot?: string;
}
type StoredInput = Omit<ConfirmedNamedKaVmLifecycleInput, 'packedKaId'> & { packedKaId?: string };
interface RepairEntry {
  input: StoredInput;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  rejected?: boolean;
}
export type NamedKaVmLifecycleRepairOutcome = 'repaired' | 'pending' | 'superseded' | 'rejected';

/** A confirmed transaction is never submitted again by this owner: it only repairs local evidence. */
export class NamedKaVmLifecycleRepair {
  private entries = new Map<string, RepairEntry>();
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();
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
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private key(input: StoredInput): string {
    return createHash('sha256').update(JSON.stringify([
      input.contextGraphId, input.agentAddress.toLowerCase(), input.name, input.subGraphName ?? '',
    ])).digest('hex');
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.options.dataDir) {
      try {
        const parsed = JSON.parse(await readFile(join(this.options.dataDir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
        if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Invalid named KA lifecycle repair journal');
        for (const [key, entry] of parsed.entries as Array<[string, RepairEntry]>) {
          this.validate(entry.input);
          if (key !== this.key(entry.input) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0
            || !Number.isSafeInteger(entry.nextAttemptAt) || entry.nextAttemptAt < 0) throw new Error('Invalid named KA lifecycle repair entry');
          this.entries.set(key, entry);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.loaded = true;
  }
  private validate(input: StoredInput): void {
    if (!input.contextGraphId || !input.agentAddress || !input.name || !input.publishedUal
      || !/^(0x)?[0-9a-f]{64}$/i.test(input.merkleRoot)
      || !/^[1-9][0-9]*$/.test(input.assertionVersion)
      || (input.packedKaId !== undefined && !/^[0-9]+$/.test(input.packedKaId))
      || (input.priorMerkleRoot !== undefined && !/^(0x)?[0-9a-f]{64}$/i.test(input.priorMerkleRoot))) {
      throw Object.assign(new Error('Invalid confirmed named KA lifecycle repair evidence'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
    }
  }
  private async persist(): Promise<void> {
    const dir = this.options.dataDir;
    if (!dir) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'named-ka-vm-lifecycle-repairs.json');
    const temporary = join(dir, `.named-ka-vm-lifecycle-repairs.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, entries: [...this.entries] }));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, path);
      let directory: FileHandle | undefined;
      try {
        directory = await open(dir, 'r');
        await directory.sync();
      } catch (error) {
        // Some platforms cannot fsync a directory; the journal file is already fsynced.
        if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await directory?.close(); }
    } finally { await rm(temporary, { force: true }); }
  }

  async submit(input: ConfirmedNamedKaVmLifecycleInput): Promise<NamedKaVmLifecycleRepairOutcome> {
    return this.serial(async () => {
      if (this.stopped) throw new Error('Named KA lifecycle repair owner is stopped');
      await this.load();
      const { packedKaId, ...fields } = input;
      const stored: StoredInput = { ...fields, merkleRoot: input.merkleRoot.toLowerCase().replace(/^0x/, ''),
        ...(input.priorMerkleRoot ? { priorMerkleRoot: input.priorMerkleRoot.toLowerCase().replace(/^0x/, '') } : {}),
        ...(packedKaId === undefined ? {} : { packedKaId: packedKaId.toString() }) };
      this.validate(stored);
      const key = this.key(stored);
      const previous = this.entries.get(key);
      if (previous && BigInt(previous.input.assertionVersion) > BigInt(input.assertionVersion)) return 'superseded';
      if (previous && previous.input.assertionVersion === input.assertionVersion
        && previous.input.merkleRoot !== stored.merkleRoot) {
        throw Object.assign(new Error('Conflicting confirmed roots at the same assertion version'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
      }
      // Persist before the first graph-store call. Any partial stamp can be replayed after restart.
      const entry = previous?.input.assertionVersion === input.assertionVersion
        ? previous : { input: stored, attempts: 0, nextAttemptAt: this.now() };
      this.entries.set(key, entry);
      await this.persist();
      if (entry.rejected) return 'rejected';
      if (entry.nextAttemptAt > this.now()) return 'pending';
      return this.attempt(key, entry);
    });
  }
  private async attempt(key: string, entry: RepairEntry): Promise<NamedKaVmLifecycleRepairOutcome> {
    const { packedKaId, ...fields } = entry.input;
    const input: ConfirmedNamedKaVmLifecycleInput = { ...fields,
      ...(packedKaId === undefined ? {} : { packedKaId: BigInt(packedKaId) }) };
    let outcome: NamedKaVmLifecycleRepairOutcome;
    try {
      if (!await this.options.isCurrent(input)) {
        this.entries.delete(key);
        outcome = 'superseded';
      } else {
        await this.options.apply(input);
        this.entries.delete(key);
        outcome = 'repaired';
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // Admission/timeouts and RPC availability are transient. Invalid evidence is never retried.
      const permanent = code === 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY';
      entry.attempts += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.rejected = permanent;
      entry.nextAttemptAt = this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(entry.attempts - 1, 6));
      const storePressure = isStoreSchedulerBusyError(error) || isStoreOperationTimeoutError(error);
      this.options.warn(`Confirmed named KA ${input.name} lifecycle repair ${permanent ? 'rejected' : 'pending'}${storePressure ? ' under store pressure' : ''}: ${entry.lastError}`);
      outcome = permanent ? 'rejected' : 'pending';
    }
    await this.persist();
    return outcome;
  }
  async runDue(): Promise<void> {
    return this.serial(async () => {
      if (this.stopped) return;
      await this.load();
      // One serialized batch with a finite admission budget; failed entries retain their deadlines.
      const due = [...this.entries].filter(([, entry]) => !entry.rejected && entry.nextAttemptAt <= this.now())
        .sort((a, b) => a[1].nextAttemptAt - b[1].nextAttemptAt).slice(0, 10);
      for (const [key, entry] of due) {
        if (this.stopped) break;
        await this.attempt(key, entry);
      }
    });
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
    await this.tail;
  }
}
