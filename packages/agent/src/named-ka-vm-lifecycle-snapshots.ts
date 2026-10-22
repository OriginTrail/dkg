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
        // A cleanup already dispatched before our pin may still unlink this ref.
        // Wait for physical retirement before trusting the cache or recreating it.
        await this.cleaning?.catch(() => {});
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

  /** Called under journal serialization, only after the compact journal's durable commit. */
  retireUnreferenced(entries: ReadonlyMap<string, LifecycleRepairEntry>): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const retained = new Set([...entries.values()].map(entry => entry.input.materialization && this.references.get(entry.input.materialization)));
    // Register ownership before invoking any filesystem callback.
    const task = Promise.resolve().then(async () => {
      let files: string[];
      try { files = await readdir(this.directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const obsolete = files.filter(file => /^[a-f0-9]{64}\.json$/.test(file)
        && !retained.has(file.slice(0, -5)) && !this.pins.has(file.slice(0, -5))).slice(0, 10);
      for (const file of obsolete) {
        const ref = file.slice(0, -5);
        if (this.pins.has(ref)) continue;
        this.durable.delete(ref);
        try { await unlink(join(this.directory, file)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    });
    this.cleaning = task;
    void task.finally(() => { if (this.cleaning === task) this.cleaning = undefined; }).catch(() => {});
    return task;
  }
}
