/**
 * The startup sweep of the SWM host-mode store's data directory (run by
 * `SwmHostModeStore.init()` and `reconcileOrphanLogsNow()`): it reaps what a
 * crash leaves behind and nothing else.
 *
 *   - `.log` files without a healthy `.meta` (orphans);
 *   - `.meta` files that do not parse as a JSON object with a non-empty
 *     `contextGraphId` (corrupt);
 *   - stale `<file>.tmp-*` temp files, through `DurableFiles.removeStaleTempFiles`
 *     (a temp this instance is still writing is left alone).
 *
 * Nothing acknowledges these unlinks, so none is directory-synced: a
 * resurrected orphan, corrupt meta or temp is reaped again by the next sweep.
 * A `.meta` that cannot be READ (EIO, EACCES, EMFILE, ...) is never reaped as
 * corrupt, and neither is its paired `.log`. Every removal is best-effort.
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { isDurableTempFileName, type DurableFiles } from './host-store-durable-fs.js';
import type { SwmHostModeStartupReconcileReport } from './host-store-types.js';

/**
 * Scan `dataDir` for `.log` files without a matching `.meta` and
 * delete them. Orphans typically result from a crash between
 * `appendFile` (durable) and `persistMeta` (durable) during the
 * first envelope for a brand-new CG. Without meta we cannot:
 *   - serve catchup (no cleartext contextGraphId to dispatch on)
 *   - prune (the prune path keys off meta files)
 *   - report in stats
 * so the bytes are dead storage. Delete-at-init recovers the disk.
 *
 * `.meta` files without a matching `.log` are deliberately NOT
 * removed: `markRegistered` writes a meta even for CGs that have
 * never received an envelope, and a prune-to-empty leaves the meta
 * behind. Both are harmless (zero-byte footprint) and the meta
 * carries the cleartext `contextGraphId` we need for future
 * append-time meta reconstruction.
 */
export async function reconcileOrphanLogs(
  dataDir: string,
  files: DurableFiles,
): Promise<SwmHostModeStartupReconcileReport> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dataDir, { withFileTypes: true });
  } catch {
    return { orphanLogsRemoved: 0, orphanBytesRemoved: 0 };
  }
  // Codex PR #619 R2: only count a .meta as "healthy pairing
  // candidate" if it parses as valid JSON with a contextGraphId.
  // A truncated .meta (written by a build that predates the atomic
  // temp+rename `persistMeta`, or damaged out-of-band); `loadMeta()` /
  // `listKnownCgs()` already treat that as unusable, so the paired .log
  // is still unservable + unprunable and must be reaped here too.
  const validMetaKeys = new Set<string>();
  const corruptMetaNames: string[] = [];
  // Codex PR #619 follow-up: transient fs errors (EACCES, EMFILE,
  // EBUSY, etc.) on the meta read MUST NOT be reaped as corruption;
  // doing so deletes a healthy `.meta` + `.log` pair and loses
  // hosted ciphertext on startup. Track keys whose meta we could not
  // read so the paired `.log` is also retained for a later retry.
  const ioSkippedMetaKeys = new Set<string>();
  const logFiles: { key: string; name: string }[] = [];
  const tempFileNames: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (isDurableTempFileName(e.name)) {
      // A crash between creating a `writeFileDurable` temp and renaming it
      // over its target. The target is intact; the temp is dead weight.
      tempFileNames.push(e.name);
    } else if (e.name.endsWith('.meta')) {
      const metaPath = path.join(dataDir, e.name);
      const metaKey = e.name.slice(0, -'.meta'.length);
      let raw: string;
      try {
        raw = await fs.readFile(metaPath, 'utf-8');
      } catch {
        ioSkippedMetaKeys.add(metaKey);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        corruptMetaNames.push(e.name);
        continue;
      }
      if (
        parsed && typeof parsed === 'object'
        && typeof (parsed as { contextGraphId?: unknown }).contextGraphId === 'string'
        && (parsed as { contextGraphId: string }).contextGraphId.length > 0
      ) {
        validMetaKeys.add(metaKey);
      } else {
        corruptMetaNames.push(e.name);
      }
    } else if (e.name.endsWith('.log')) {
      logFiles.push({ key: e.name.slice(0, -'.log'.length), name: e.name });
    }
  }
  let orphanLogsRemoved = 0;
  let orphanBytesRemoved = 0;
  let corruptMetasRemoved = 0;
  let corruptMetaBytesRemoved = 0;
  for (const { key, name } of logFiles) {
    if (validMetaKeys.has(key)) continue;
    if (ioSkippedMetaKeys.has(key)) continue;
    const fullPath = path.join(dataDir, name);
    try {
      const stat = await fs.stat(fullPath);
      orphanBytesRemoved += stat.size;
      await fs.rm(fullPath, { force: true });
      orphanLogsRemoved += 1;
    } catch {
      // best-effort; another process may have removed the file
    }
  }
  for (const name of corruptMetaNames) {
    const fullPath = path.join(dataDir, name);
    try {
      const stat = await fs.stat(fullPath);
      corruptMetaBytesRemoved += stat.size;
      await fs.rm(fullPath, { force: true });
      corruptMetasRemoved += 1;
    } catch {
      // best-effort
    }
  }
  // A write of this very instance may be mid-flight (only reachable via
  // `reconcileOrphanLogsNow()` after init): `DurableFiles` leaves its temp alone.
  const staleTempFilesRemoved = await files.removeStaleTempFiles(dataDir, tempFileNames);
  const report: SwmHostModeStartupReconcileReport = {
    // Backwards-compatible aggregate: older callers treat these as
    // "files/bytes reaped by startup reconcile", including corrupt
    // .meta files. Keep that contract and expose the split counter
    // only as an optional drill-down.
    orphanLogsRemoved: orphanLogsRemoved + corruptMetasRemoved,
    orphanBytesRemoved: orphanBytesRemoved + corruptMetaBytesRemoved,
  };
  if (corruptMetasRemoved > 0) report.corruptMetasRemoved = corruptMetasRemoved;
  if (staleTempFilesRemoved > 0) report.staleTempFilesRemoved = staleTempFilesRemoved;
  return report;
}
