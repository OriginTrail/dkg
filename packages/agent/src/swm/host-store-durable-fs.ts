/**
 * Crash-safe file operations for `SwmHostModeStore` (host-mode-store.ts): the
 * filesystem durability state machine, kept apart from the store's policy (CG
 * metadata, sequence allocation, retention, cold load, tail repair decisions).
 *
 * `DurableFiles` owns, for one store instance:
 *   - whole-file replace (`writeFileDurable`): sibling temp file + fsync +
 *     `rename` over the target + directory fsync, so a crash or power loss
 *     leaves the old file or the new file, never a torn one;
 *   - durable unlink (`unlinkDurable`) and durable append / truncate
 *     (`appendFileDurable`, `truncateFileDurable`);
 *   - the bookkeeping of directory changes whose directory fsync has not yet
 *     succeeded (`pendingDirSync`, `completePendingDirSync`);
 *   - the temp-file lifecycle: the `<key>.<log|meta>.tmp-<pid>-<uuid>` naming,
 *     the set of temps this instance has in flight, and the sweep of stale ones.
 *
 * Leftover `<file>.tmp-*` siblings from a crash are inert (the store's scans
 * key off the `.log` / `.meta` suffix) and are swept by the store's `init()`
 * through `removeStaleTempFiles`.
 *
 * A rename can succeed while its directory fsync fails: the write rejects, but
 * the new file is already visible, so a retry that merely reads the file would
 * find the requested state and acknowledge it without ever making the rename
 * durable. `DurableFiles` therefore remembers every target whose rename (or
 * unlink) is not yet covered by a successful directory fsync (`pendingDirSync`)
 * and `completePendingDirSync` finishes that fsync before the store
 * acknowledges an idempotent no-op on such a file (a `mark*` whose flag already
 * matches, a prune that finds nothing left to drop).
 *
 * Guaranteed, per `DurableFiles` instance (the store owns exactly one): an
 * acknowledged `writeFileDurable` or `unlinkDurable` was covered by a
 * directory fsync that STARTED after its rename or unlink returned and then
 * succeeded. A mark is about one directory change, not about a path: each
 * rename or unlink gets a generation, and a directory fsync forgets only the
 * targets (with the generations) it had seen when it started. So a target that
 * is changed again, and whose own fsync fails, stays pending even while an
 * older fsync that had already seen it is still in flight. A failing retry
 * keeps the mark, and with nothing pending no extra fsync is issued.
 *
 * Not guaranteed: a rename or unlink applied by a process that was killed
 * before its directory fsync (the next process cannot know and takes the
 * visible directory as current; only a power loss inside the kernel's
 * write-back window can still revert it), and anything across two instances
 * (they share no pending marks).
 *
 * The calls reach the filesystem through the shared `promises` object of
 * `node:fs` and the RFC-64 directory fsync, looked up at call time, so tests
 * can spy on them.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fsyncRfc64DirectoryV1 } from '../rfc64/secure-filesystem-policy-v1.js';

/**
 * Infix of the sibling temp file used for crash-safe whole-file writes:
 * `<key>.<log|meta>.tmp-<pid>-<uuid>`. It never ends in `.log` / `.meta`,
 * so the directory scans that key off those suffixes ignore it.
 */
const TEMP_FILE_INFIX = '.tmp-';
const TEMP_FILE_NAME = /^[A-Za-z0-9_-]+\.(?:log|meta)\.tmp-/;

/** Is `name` (a directory entry) a temp file left by `writeFileDurable`? */
export function isDurableTempFileName(name: string): boolean {
  return TEMP_FILE_NAME.test(name);
}

export class DurableFiles {
  /**
   * Targets (`.meta` / `.log`) whose directory entry changed (a rename over it,
   * or the unlink of the log) but whose directory fsync has not (yet)
   * succeeded, each with the generation of the change it stands for. The
   * generation is what makes a mark about ONE change rather than about a path:
   * see `syncDirectory`. The caller must not overlap writers of the same target
   * (the store's per-CG write lock, plus the cold-load initialization that
   * every mutator awaits), so a target's generations are recorded in change
   * order.
   */
  private readonly pendingDirSync = new Map<string, number>();
  /** Source of generations (one per rename or unlink this instance applied). */
  private directoryChangeGeneration = 0;
  /** Temp files currently being written by this instance; the sweep must not reap them. */
  private readonly liveTempPaths = new Set<string>();

  /**
   * Crash-safe whole-file replace: write a sibling temp file, fsync it,
   * `rename` it over `targetPath`, then fsync the directory so the rename
   * itself survives a power loss. A crash at any point leaves `targetPath`
   * holding either its previous contents or the new ones; the worst leftover
   * is an inert `<target>.tmp-*` sibling that the store's `init()` sweeps. On
   * failure the temp file is removed (best-effort) and the error is rethrown.
   *
   * If the directory fsync is the step that fails, the rename has already
   * happened: the new file is visible even though this call rejects, and the
   * target stays in `pendingDirSync` until a directory fsync succeeds (see
   * `syncDirectoryChange`). (A `rename` that rejects is taken not to have
   * happened: it is atomic.)
   *
   * The temp handle is opened for writing and synced in place, so no
   * separate re-open is needed (which also keeps `FlushFileBuffers` happy on
   * Windows). The directory fsync is `fsyncRfc64DirectoryV1`, which is
   * already a no-op on Windows. Not adopting the RFC-64 owner-only file
   * policy: the temp keeps the default mode the previous `writeFile` used.
   */
  async writeFileDurable(targetPath: string, bytes: Uint8Array | string): Promise<void> {
    const tempPath = `${targetPath}${TEMP_FILE_INFIX}${process.pid}-${randomUUID()}`;
    this.liveTempPaths.add(tempPath);
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, 'wx');
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      if (handle) await handle.close().catch(() => { /* already failing */ });
      await fs.rm(tempPath, { force: true }).catch(() => { /* best-effort */ });
      throw err;
    } finally {
      this.liveTempPaths.delete(tempPath);
    }
    await this.syncDirectoryChange(targetPath);
  }

  /**
   * Remove `targetPath` (no error when it is already gone) and make the unlink
   * durable. An unlink is a directory-entry change exactly like a rename:
   * without the directory fsync a power loss could bring the removed file back.
   * If the fsync fails the target stays pending, like a renamed one.
   */
  async unlinkDurable(targetPath: string): Promise<void> {
    await fs.rm(targetPath, { force: true });
    await this.syncDirectoryChange(targetPath);
  }

  /**
   * Append `bytes` to `filePath` and fsync it before returning. Creating a
   * brand-new log leaves its directory entry to the directory fsync that the
   * paired `writeFileDurable` of the `.meta` performs right after (same
   * directory); a crash in between yields, at worst, an orphan `.log` that the
   * store's `init()` reaps.
   */
  async appendFileDurable(filePath: string, bytes: Uint8Array): Promise<void> {
    const handle = await fs.open(filePath, 'a');
    try {
      await handle.appendFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Truncate `filePath` to `length` bytes and fsync it before returning. */
  async truncateFileDurable(filePath: string, length: number): Promise<void> {
    const handle = await fs.open(filePath, 'r+');
    try {
      await handle.truncate(length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Make a rename (or unlink) of `targetPath` that an earlier attempt left
   * without a successful directory fsync durable. A no-op (no fsync at all) when
   * nothing is pending for the target; rejects, keeping the mark, when the fsync
   * fails.
   */
  async completePendingDirSync(targetPath: string): Promise<void> {
    if (!this.pendingDirSync.has(targetPath)) return;
    await this.syncDirectory(path.dirname(targetPath));
  }

  /**
   * Delete the stale temp files `names` (entries of `dir` that
   * `isDurableTempFileName` accepted; a crash between creating a
   * `writeFileDurable` temp and renaming it over its target, where the target
   * is intact and the temp is dead weight), one at a time and best-effort, and
   * return how many were removed. A temp this very instance is still writing
   * (only reachable when the sweep runs after `init()`) is left alone. Nothing
   * acknowledges these unlinks, so they are not directory-synced: a resurrected
   * temp is swept again by the next init.
   */
  async removeStaleTempFiles(dir: string, names: readonly string[]): Promise<number> {
    let removed = 0;
    for (const name of names) {
      const fullPath = path.join(dir, name);
      if (this.liveTempPaths.has(fullPath)) continue;
      try {
        await fs.rm(fullPath, { force: true });
        removed += 1;
      } catch {
        // best-effort
      }
    }
    return removed;
  }

  /**
   * The step after a rename over `targetPath`, or the unlink of it, has
   * returned: the new directory state is visible, and the directory fsync
   * decides whether it is also durable. The change's generation is taken now,
   * synchronously, right after the call returned (nothing can interleave before
   * it). If the fsync fails the target stays in `pendingDirSync` with that
   * generation and the error is rethrown.
   */
  private async syncDirectoryChange(targetPath: string): Promise<void> {
    const generation = (this.directoryChangeGeneration += 1);
    try {
      await this.syncDirectory(path.dirname(targetPath));
    } catch (err) {
      this.pendingDirSync.set(targetPath, generation);
      throw err;
    }
  }

  /**
   * fsync `dir` and, only once that succeeded, forget the pending targets in it
   * that this fsync covers: a pending mark is about one directory change, and
   * an fsync covers exactly the changes (renames, unlinks) that had returned
   * before it started. So the targets (with their generations) are snapshotted
   * BEFORE the fsync, and a target is deleted afterwards only if its entry
   * still has the snapshotted generation. A target that was changed again in
   * the meantime and failed its own fsync has a newer generation and stays
   * pending, even though its path was already in the map; a change that lands,
   * and fails, while this fsync is in flight is not in the snapshot at all.
   *
   * Conservative in one direction only: a change that returned before this
   * fsync started but whose own (failing) fsync only recorded it afterwards is
   * not in the snapshot, so it is synced once more on retry.
   */
  private async syncDirectory(dir: string): Promise<void> {
    const covered = [...this.pendingDirSync].filter(([target]) => path.dirname(target) === dir);
    await fsyncRfc64DirectoryV1(dir);
    for (const [target, generation] of covered) {
      if (this.pendingDirSync.get(target) === generation) this.pendingDirSync.delete(target);
    }
  }
}
