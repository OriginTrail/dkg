// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DurableReplaceableFile } from './durable-file-replace.js';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { decodeLifecycleRepairJournal, encodeLifecycleRepairJournal, type LifecycleRepairEntry } from './named-ka-vm-lifecycle-repair-journal.js';
import type { ConfirmedLifecycleMaterialization } from './named-ka-vm-lifecycle-materialization.js';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const validRef = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Immutable snapshots are durable before their compact retry records become visible. */
export class NamedKaVmLifecycleSnapshots {
  private readonly references = new WeakMap<ConfirmedLifecycleMaterialization, string>();
  private readonly durable = new Set<string>();
  private readonly directory: string;
  constructor(dataDir: string) { this.directory = join(dataDir, 'named-ka-vm-lifecycle-snapshots'); }

  async decode(value: unknown): Promise<Map<string, LifecycleRepairEntry>> {
    const journal = value as { version?: unknown; entries?: unknown } | null;
    if (journal?.version !== 4) return decodeLifecycleRepairJournal(value);
    if (!Array.isArray(journal.entries)) return decodeLifecycleRepairJournal(value);
    const snapshots = new Map<string, unknown>(), byKey = new Map<string, string>();
    for (const tuple of journal.entries) {
      const ref = Array.isArray(tuple) ? tuple[1]?.input?.materializationRef : undefined;
      if (ref === undefined) continue;
      if (!validRef(ref)) throw new NamedKaVmLifecycleIntegrityError('Invalid lifecycle snapshot reference');
      if (!snapshots.has(ref)) {
        const bytes = await readFile(join(this.directory, `${ref}.json`), 'utf8');
        if (digest(bytes) !== ref) throw new NamedKaVmLifecycleIntegrityError('Lifecycle snapshot digest mismatch');
        snapshots.set(ref, JSON.parse(bytes));
      }
      byKey.set(tuple[0], ref);
    }
    const entries = decodeLifecycleRepairJournal(value, snapshots);
    for (const [key, entry] of entries) {
      const ref = byKey.get(key);
      if (ref && entry.input.materialization) {
        this.references.set(entry.input.materialization, ref); this.durable.add(ref);
      }
    }
    return entries;
  }

  async encode(entries: ReadonlyMap<string, LifecycleRepairEntry>): Promise<ReturnType<typeof encodeLifecycleRepairJournal>> {
    for (const entry of entries.values()) {
      const snapshot = entry.input.materialization;
      if (!snapshot) continue;
      const cached = this.references.get(snapshot);
      if (cached && this.durable.has(cached)) continue;
      const bytes = JSON.stringify(snapshot), ref = cached ?? digest(bytes);
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
