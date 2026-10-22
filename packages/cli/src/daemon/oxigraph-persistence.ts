// SPDX-License-Identifier: Apache-2.0
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DurableDirectory, TripleStorePersistenceBarrier } from '@origintrail-official/dkg-storage';
import { readRetainedWalSegmentNames } from './oxigraph-wal.js';

/**
 * Oxigraph 0.5.8 uses the RocksDB default WAL: a successful HTTP mutation has
 * written its log bytes to the OS, but has not synced them to stable storage.
 * Version/settings-bound workaround for the daemon-owned local database. This
 * is not an engine-owned durability API: it cannot observe RocksDB's writer
 * boundary or native sticky error state. Replacement with that API is required
 * before claiming a complete managed persistence integration.
 *
 * A retired/recycled log is safe only after RocksDB installs durable SST and
 * manifest state. Recheck the numeric names and retry on turnover. Open r+,
 * never create/truncate: Windows FlushFileBuffers requires write access.
 * Windows follows pinned RocksDB's native SyncWAL policy (directory fsync is
 * explicitly a no-op there); POSIX requires a successful directory fsync.
 */
export function createManagedOxigraphPersistenceBarrierV1(
  directoryOwner: DurableDirectory,
  version: string,
): TripleStorePersistenceBarrier | undefined {
  if (version !== '0.5.8') return undefined;
  let walFailure: unknown;
  return async (options) => {
    // A new descriptor may not observe the writeback error already consumed by
    // another sync. Only replacing the owner after engine recovery/reapplication
    // can restore trust; this owner must never certify the visible memtable.
    if (walFailure !== undefined) throw walFailure;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      options?.signal?.throwIfAborted();
      try {
        // Resolve before joining filenames: symlink/.. must identify the same
        // database for discovery and fsync, never a lexical-path decoy.
        const directory = await realpath(directoryOwner.path);
        const before = await readRetainedWalSegmentNames(directory);
        if (before.length === 0) throw new Error('Managed Oxigraph persistence awaits an active WAL');
        for (const name of before) {
          options?.signal?.throwIfAborted();
          try {
            const file = await open(join(directory, name), 'r+');
            try { await file.sync(); } finally { await file.close(); }
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') walFailure ??= error;
            throw error;
          }
        }
        await directoryOwner.persist();
        options?.signal?.throwIfAborted();
        const after = await readRetainedWalSegmentNames(directory);
        options?.signal?.throwIfAborted();
        if (walFailure !== undefined) throw walFailure;
        if (before.length === after.length && before.every((name, index) => name === after[index])) return;
      } catch (error) {
        options?.signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    }
    throw new Error('Managed Oxigraph WAL changed during the persistence barrier; retain repair evidence');
  };
}
