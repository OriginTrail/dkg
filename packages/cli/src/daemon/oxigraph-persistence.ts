// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { DurableDirectory, TripleStorePersistenceBarrier } from '@origintrail-official/dkg-storage';
import { readRetainedWalSegmentNames } from './oxigraph-wal.js';

/**
 * Oxigraph 0.5.8 uses the RocksDB default WAL: a successful HTTP mutation has
 * written its log bytes to the OS, but has not synced them to stable storage.
 * This barrier supplies that missing step for the daemon-owned local database.
 * It does not certify arbitrary HTTP endpoints or a different engine version.
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
  const directory = directoryOwner.path;
  return async (options) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      options?.signal?.throwIfAborted();
      try {
        const before = await readRetainedWalSegmentNames(directory);
        if (before.length === 0) throw new Error('Managed Oxigraph persistence awaits an active WAL');
        for (const name of before) {
          options?.signal?.throwIfAborted();
          const file = await open(join(directory, name), 'r+');
          try { await file.sync(); } finally { await file.close(); }
        }
        await directoryOwner.persist();
        options?.signal?.throwIfAborted();
        const after = await readRetainedWalSegmentNames(directory);
        options?.signal?.throwIfAborted();
        if (before.length === after.length && before.every((name, index) => name === after[index])) return;
      } catch (error) {
        options?.signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    }
    throw new Error('Managed Oxigraph WAL changed during the persistence barrier; retain repair evidence');
  };
}
