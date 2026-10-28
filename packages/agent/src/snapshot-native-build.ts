// SPDX-License-Identifier: Apache-2.0
import { openSnapshotNativeStore } from './snapshot-native-store.js';
import { nativeCheckpointProperties } from './snapshot-native-properties.js';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, statfs } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BlazegraphStore } from '@origintrail-official/dkg-storage';
import type { preparePublicSnapshotCheckpoint } from './public-snapshot-checkpoint.js';
import { checkpointAssetPath, checkpointSha256, syncCheckpointDirectory, writeCheckpointFile } from './snapshot-checkpoint-files.js';
import { startSnapshotNativeProcess } from './snapshot-native-process.js';
import { auditSnapshotCheckpoint } from './snapshot-checkpoint-audit.js';

type Prepared = Awaited<ReturnType<typeof preparePublicSnapshotCheckpoint>>;
const RESERVE = 7 * 2 ** 30;

export async function nativeCheckpointShaFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await input.close(); }
  return hash.digest('hex');
}
async function copyPinned(source: string, target: string, digest: string, max: number) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size > max) throw new Error('Unsafe checkpoint load input');
    const bytes = await input.readFile();
    if (checkpointSha256(bytes) !== digest) throw new Error('Checkpoint load input changed');
    await writeCheckpointFile(target, bytes);
  } finally { await input.close(); }
}
/** Build only a new, private, unpublished journal. Existing stores and configs are never replaced. */
export async function buildNativeSnapshotCheckpoint(prepared: Prepared, options: {
  java: string; jar: string; jarSha256: string; signal: AbortSignal;
  /** Re-authenticate the current source inventory using the selected chain policy. */
  assertInventoryCurrent(): Promise<void>;
}) {
  const { directory, manifest } = prepared;
  const constrained = process.constrainedMemory();
  if (Math.min(totalmem(), constrained || Infinity) < 4 * 2 ** 30) throw new Error('Native bootstrap requires a 4 GiB memory allowance; use incremental recovery');
  if (!isAbsolute(options.java) || !isAbsolute(options.jar) || !/^[a-f0-9]{64}$/.test(options.jarSha256))
    throw new Error('Native checkpoint requires an explicit pinned Java/Blazegraph runtime');
  if (await nativeCheckpointShaFile(options.jar) !== options.jarSha256) throw new Error('Native checkpoint runtime hash mismatch');
  if (manifest.state !== 'verified-unpublished' || !manifest.assets.length
    || manifest.plainBytes > 8 * 2 ** 30 || manifest.encodedBytes > 2 ** 30) throw new Error('Invalid checkpoint build profile');
  const remaining = manifest.deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > 3_600_000) throw new Error('Checkpoint job deadline exceeded');
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const timer = setTimeout(() => abort.abort(new Error('Checkpoint job deadline exceeded')), remaining);
  const folder = join(directory, 'native');
  let owned: Awaited<ReturnType<typeof startSnapshotNativeProcess>> | undefined;
  let store: BlazegraphStore | undefined;
  const guard = async () => {
    signal.throwIfAborted();
    const disk = await statfs(directory);
    if (disk.bavail * disk.bsize <= RESERVE) throw new Error('Checkpoint disk reserve unavailable');
  };
  let monitorBusy = false;
  const monitor = setInterval(() => {
    if (monitorBusy) return;
    monitorBusy = true;
    void guard().catch(error => abort.abort(error)).finally(() => { monitorBusy = false; });
  }, 1000);
  try {
    await guard(); await options.assertInventoryCurrent(); signal.throwIfAborted();
    const disk = await statfs(directory);
    if (disk.bavail * disk.bsize <= RESERVE + 3 * manifest.plainBytes + manifest.encodedBytes)
      throw new Error('Insufficient space for isolated checkpoint journal and retained inputs');
    await mkdir(folder, { mode: 0o700 });
    const pinnedJar = join(folder, 'runtime.jar');
    await copyFile(options.jar, pinnedJar, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    if (await nativeCheckpointShaFile(pinnedJar) !== options.jarSha256) throw new Error('Native runtime copy mismatch');
    const input = join(folder, 'input'); await mkdir(input, { mode: 0o700 });
    for (const asset of manifest.assets) {
      signal.throwIfAborted();
      for (const [suffix, hash, max] of [
        ['verified.nq.gz', asset.dataSha256, 16 * 1024 * 1024],
        ['verified.meta.nq', asset.metadataSha256, 128 * 1024],
      ] as const) await copyPinned(checkpointAssetPath(join(directory, 'load'), asset.index, suffix),
        checkpointAssetPath(input, asset.index, suffix), hash, max);
    }
    await copyPinned(join(directory, 'load/trust.nq'), join(input, 'trust.nq'), manifest.trustSha256, 4096);
    await syncCheckpointDirectory(input);
    const journal = join(folder, 'store.jnl');
    const properties = nativeCheckpointProperties(journal);
    await writeCheckpointFile(join(folder, 'load.properties'), properties);
    await writeCheckpointFile(join(folder, 'audit.properties'), properties + 'com.bigdata.journal.AbstractJournal.readOnly=true\n');
    const java = ['-Xms256m', '-Xmx3g', `-XX:ActiveProcessorCount=${Math.min(4, availableParallelism())}`];
    const started = Date.now();
    owned = await startSnapshotNativeProcess(options.java, [...java, '-cp', pinnedJar, 'com.bigdata.rdf.store.DataLoader',
      '-namespace', 'kb', join(folder, 'load.properties'), input], folder, join(folder, 'loader.log'), signal);
    await owned.closed; await owned.stop(); owned = undefined;
    await guard();
    const loaderMs = Date.now() - started;
    const file = await open(journal, 'r'); try { await file.sync(); } finally { await file.close(); }
    const journalSha256 = await nativeCheckpointShaFile(journal);
    store = await openSnapshotNativeStore({ java: options.java, jar: pinnedJar,
      properties: join(folder, 'audit.properties'), folder, log: join(folder, 'audit.log'), signal });
    const audited = await auditSnapshotCheckpoint(store, manifest, signal);
    await store.close(); store = undefined;
    if (await nativeCheckpointShaFile(journal) !== journalSha256) throw new Error('Read-only checkpoint audit changed the journal');
    await options.assertInventoryCurrent(); await guard();
    const result = { version: 1, state: 'verified-unpublished', ...audited, journal, journalSha256,
      inventoryDigest: manifest.observation.snapshot.inventoryDigest, runtimeSha256: options.jarSha256,
      propertiesSha256: checkpointSha256(Buffer.from(properties)),
      loaderMs, elapsedMs: Date.now() - started, current: false, activeStoreChanged: false };
    await writeCheckpointFile(join(folder, 'READY.json'), JSON.stringify(result));
    await syncCheckpointDirectory(folder);
    return result;
  } finally {
    clearTimeout(timer); clearInterval(monitor);
    await Promise.allSettled([store?.close(), owned?.stop()]);
  }
}
