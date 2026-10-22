// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DurableDirectory } from '@origintrail-official/dkg-storage';
import { DurableReplaceableFile } from './durable-file-replace.js';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { decodeLifecycleRepairJournalWire, hydrateLifecycleRepairWireEntry, encodeLifecycleRepairJournal, lifecycleMaterializationWire, type LifecycleRepairEntry } from './named-ka-vm-lifecycle-repair-journal.js';
import type { ConfirmedLifecycleMaterialization, ValidatedLifecycleMaterialization } from './named-ka-vm-lifecycle-evidence.js';

export interface LifecycleSnapshotLease { release(): void }
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
/** Immutable snapshots are durable before their compact retry records become visible. */
export class NamedKaVmLifecycleSnapshots {
  private readonly references = new WeakMap<ConfirmedLifecycleMaterialization, string>();
  private readonly durable = new Set<string>();
  private readonly directory: string;
  private readonly directoryDurability: DurableDirectory;
  private directoryReady = false;
  private ready?: Promise<void>;
  private cleaning?: Promise<void>;
  private readonly retiring = new Map<string, Promise<void>>();
  private retained = new Set<string | undefined>();
  private retirementAllowed = false;
  private cleanupRequested = false;
  private readonly pins = new Map<string, number>();
  private readonly preparing = new Map<string, Promise<void>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(dataDir: string) {
    this.directory = join(dataDir, 'named-ka-vm-lifecycle-snapshots');
    this.directoryDurability = new DurableDirectory(this.directory, { mode: 0o700 });
  }

  async decode(value: unknown): Promise<Map<string, LifecycleRepairEntry>> {
    const wireEntries = decodeLifecycleRepairJournalWire(value);
    const snapshots = new Map<string, unknown>(), entries = new Map<string, LifecycleRepairEntry>();
    for (const [key, wire] of wireEntries) {
      const ref = wire.materializationRef;
      if (ref !== undefined && !snapshots.has(ref)) {
        const bytes = await readFile(join(this.directory, `${ref}.json`), 'utf8');
        if (digest(bytes) !== ref) throw new NamedKaVmLifecycleIntegrityError('Lifecycle snapshot digest mismatch');
        snapshots.set(ref, JSON.parse(bytes));
      }
      const entry = hydrateLifecycleRepairWireEntry(wire, ref === undefined ? undefined : snapshots.get(ref));
      entries.set(key, entry);
      if (ref && entry.input.materialization) {
        this.references.set(entry.input.materialization, ref); this.durable.add(ref);
      }
    }
    return entries;
  }

  private ensureDirectory(): Promise<void> {
    if (this.directoryReady) return Promise.resolve();
    return this.ready ??= (async () => {
      await this.directoryDurability.create(); await this.directoryDurability.persist();
      this.directoryReady = true;
    })().catch(error => { this.ready = undefined; throw error; });
  }

  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>(resolve => { this.waiters.push(resolve); });
    else this.active++;
    try { return await work(); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }

  /** Own one immutable reference through the caller's compact admission transaction. */
  async prepare(snapshot?: ValidatedLifecycleMaterialization): Promise<LifecycleSnapshotLease> {
    if (!snapshot) { await this.ensureDirectory(); return { release() {} }; }
    return this.withSlot(async () => {
      const cached = this.references.get(snapshot);
      let bytes: string | undefined;
      const ref = cached ?? digest(bytes = JSON.stringify(lifecycleMaterializationWire(snapshot)));
      this.pins.set(ref, (this.pins.get(ref) ?? 0) + 1);
      let released = false;
      const lease = { release: () => {
        if (released) return; released = true;
        const remaining = (this.pins.get(ref) ?? 1) - 1;
        if (remaining) this.pins.set(ref, remaining); else this.pins.delete(ref);
      } };
      this.references.set(snapshot, ref);
      try {
        // An unlink dispatched before our pin may still retire this same ref.
        // Unrelated cleanup must not block independent snapshot preparations.
        await this.retiring.get(ref)?.catch(() => {});
        await this.ensureDirectory();
        if (!this.durable.has(ref)) {
          let work = this.preparing.get(ref);
          if (!work) {
            const content = bytes ?? JSON.stringify(lifecycleMaterializationWire(snapshot));
            work = Promise.resolve().then(async () => {
              await new DurableReplaceableFile(join(this.directory, `${ref}.json`), { fileMode: 0o600, directoryMode: 0o700 }).replace(content);
              this.durable.add(ref);
            });
            this.preparing.set(ref, work);
            void work.finally(() => { if (this.preparing.get(ref) === work) this.preparing.delete(ref); }).catch(() => {});
          }
          await work;
        }
        return lease;
      } catch (error) { lease.release(); throw error; }
    });
  }

  async prepareEntries(entries: ReadonlyMap<string, LifecycleRepairEntry>): Promise<LifecycleSnapshotLease[]> {
    const snapshots = [...new Set([...entries.values()].flatMap(entry => entry.input.materialization ? [entry.input.materialization] : []))];
    const results = await Promise.allSettled(snapshots.length ? snapshots.map(snapshot => this.prepare(snapshot)) : [this.prepare()]);
    const leases = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') { for (const lease of leases) lease.release(); throw failed.reason; }
    return leases;
  }

  /** No payload hashing, serialization or filesystem work inside compact admission. */
  encodePrepared(entries: ReadonlyMap<string, LifecycleRepairEntry>): ReturnType<typeof encodeLifecycleRepairJournal> {
    if (!this.directoryReady) throw new NamedKaVmLifecycleIntegrityError('Lifecycle snapshot ancestry is not prepared');
    for (const entry of entries.values()) {
      const snapshot = entry.input.materialization;
      if (snapshot && !this.durable.has(this.references.get(snapshot) ?? '')) {
        throw new NamedKaVmLifecycleIntegrityError('Lifecycle snapshot is not prepared');
      }
    }
    return encodeLifecycleRepairJournal(entries, this.references);
  }

  /** Convenience for codecs/migration; the repair owner uses explicit preparation leases. */
  async encode(entries: ReadonlyMap<string, LifecycleRepairEntry>): Promise<ReturnType<typeof encodeLifecycleRepairJournal>> {
    const leases = await this.prepareEntries(entries);
    try { return this.encodePrepared(entries); } finally { for (const lease of leases) lease.release(); }
  }

  /** Publish only a durably committed journal's reference set, synchronously. */
  publishRetained(entries: ReadonlyMap<string, LifecycleRepairEntry>): void {
    this.retained = new Set([...entries.values()].map(entry => entry.input.materialization && this.references.get(entry.input.materialization)));
    this.retirementAllowed = true;
  }

  /** An uncertain checkpoint may visibly contain refs absent from the in-memory map. */
  suspendRetirement(): void { this.retirementAllowed = false; }

  /** Optional bounded I/O is owned here, outside compact journal serialization. */
  cleanup(): Promise<void> {
    this.cleanupRequested = true;
    if (this.cleaning) return this.cleaning;
    const task = Promise.resolve().then(async () => {
      try {
        do { this.cleanupRequested = false; await this.cleanupPass(); }
        while (this.cleanupRequested && this.retirementAllowed);
      } finally { if (this.cleaning === task) this.cleaning = undefined; }
    });
    this.cleaning = task;
    return task;
  }

  private async cleanupPass(): Promise<void> {
    if (!this.retirementAllowed) return;
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let removed = 0;
    for (const file of files) {
      if (!this.retirementAllowed || removed >= 10) break;
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const ref = file.slice(0, -5);
      // Both sets may change while an earlier unlink is physically pending.
      if (this.retained.has(ref) || this.pins.has(ref)) continue;
      this.durable.delete(ref); removed++;
      const work = Promise.resolve().then(() => unlink(join(this.directory, file)));
      this.retiring.set(ref, work);
      try { await work; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      finally { if (this.retiring.get(ref) === work) this.retiring.delete(ref); }
    }
  }

  /** Standalone codec-owner convenience; the journal owner publishes before scheduling. */
  retireUnreferenced(entries: ReadonlyMap<string, LifecycleRepairEntry>): Promise<void> {
    this.publishRetained(entries); return this.cleanup();
  }

  async drain(): Promise<void> { while (this.cleaning) await this.cleaning.catch(() => {}); }
}
