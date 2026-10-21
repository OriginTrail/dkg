// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DurableDirectory } from '@origintrail-official/dkg-storage';
import { DurableReplaceableFile } from './durable-file-replace.js';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { decodeLifecycleRepairJournalWire, hydrateLifecycleRepairWireEntry, encodeLifecycleRepairJournal, lifecycleMaterializationWire, type LifecycleRepairEntry } from './named-ka-vm-lifecycle-repair-journal.js';
import type { ConfirmedLifecycleMaterialization } from './named-ka-vm-lifecycle-evidence.js';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
/** Immutable snapshots are durable before their compact retry records become visible. */
export class NamedKaVmLifecycleSnapshots {
  private readonly references = new WeakMap<ConfirmedLifecycleMaterialization, string>();
  private readonly durable = new Set<string>();
  private readonly directory: string;
  private readonly directoryDurability: DurableDirectory;
  private directoryReady = false;
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

  async encode(entries: ReadonlyMap<string, LifecycleRepairEntry>): Promise<ReturnType<typeof encodeLifecycleRepairJournal>> {
    // Every journal admission shares this ancestry, even when it has no snapshot.
    // A failed preparation stays with this owner until the complete barrier passes.
    if (!this.directoryReady) {
      await this.directoryDurability.create();
      await this.directoryDurability.persist();
      this.directoryReady = true;
    }
    for (const entry of entries.values()) {
      const snapshot = entry.input.materialization;
      if (!snapshot) continue;
      const cached = this.references.get(snapshot);
      if (cached && this.durable.has(cached)) continue;
      const bytes = JSON.stringify(lifecycleMaterializationWire(snapshot)), ref = cached ?? digest(bytes);
      if (!this.durable.has(ref)) {
        await new DurableReplaceableFile(join(this.directory, `${ref}.json`), { fileMode: 0o600, directoryMode: 0o700 }).replace(bytes);
        this.durable.add(ref);
      }
      this.references.set(snapshot, ref);
    }
    return encodeLifecycleRepairJournal(entries, this.references);
  }

  /** Called under journal serialization, only after the compact journal's durable commit. */
  async retireUnreferenced(entries: ReadonlyMap<string, LifecycleRepairEntry>): Promise<void> {
    const retained = new Set([...entries.values()].map(entry => entry.input.materialization && this.references.get(entry.input.materialization)));
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    // Bound cleanup independently of payload size; a crash can leave harmless unreferenced files.
    const obsolete = files.filter(file => /^[a-f0-9]{64}\.json$/.test(file) && !retained.has(file.slice(0, -5))).slice(0, 10);
    for (const file of obsolete) {
      await unlink(join(this.directory, file)); this.durable.delete(file.slice(0, -5));
    }
  }
}
