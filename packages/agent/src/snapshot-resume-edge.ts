// SPDX-License-Identifier: Apache-2.0
import { decodeSnapshotBootstrapRecord, type SnapshotBootstrapRecord } from './snapshot-bootstrap-record.js';
import { CheckpointInventory } from './snapshot-checkpoint-inventory.js';
import { constants } from 'node:fs';
import { lstat, open, readFile, statfs } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { normalizePublicSnapshotSyncOptions, type PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { nativeCheckpointShaFile } from './snapshot-checkpoint-files.js';
import { CHECKPOINT_PROFILE as PROFILE } from './snapshot-checkpoint-profile.js';
import { nativeCheckpointProperties } from './snapshot-native-properties.js';
import { startCheckpointEdgeSession, type CheckpointEdgeConfig } from './snapshot-checkpoint-edge-session.js';

/** Explicit restart of an Edge created by createFreshPublicCheckpointEdge. */
export async function resumePublicCheckpointEdge(options: {
  config: CheckpointEdgeConfig;
  runtime: { java: string; jarSha256: string };
  sync: PublicSnapshotSyncOptions;
  signal: AbortSignal;
}) {
  const { config, runtime } = options;
  const sync = normalizePublicSnapshotSyncOptions(options.sync);
  if (!isAbsolute(config.dataDir) || !isAbsolute(runtime.java) || config.store || config.storeConfig || config.nodeRole === 'core')
    throw new Error('Invalid checkpoint Edge restart');
  options.signal.throwIfAborted();
  const folder = join(config.dataDir, 'checkpoint-store');
  if (!(await lstat(config.dataDir)).isDirectory() || !(await lstat(folder)).isDirectory()) throw new Error('Unsafe checkpoint Edge directory');
  const file = await open(join(folder, 'BOOTSTRAP-COMPLETE.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let complete: SnapshotBootstrapRecord;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid bootstrap completion record');
    complete = decodeSnapshotBootstrapRecord(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
  if (complete.chainId !== config.chainAdapter.chainId
    || complete.deploymentId !== config.chainAdapter.deploymentId || complete.contextGraphId !== sync.contextGraphId
    || complete.onChainId !== sync.onChainId || complete.mode !== sync.mode || complete.runtimeSha256 !== runtime.jarSha256
    || !/^[a-f0-9]{64}$/.test(runtime.jarSha256)) throw new Error('Checkpoint Edge restart binding mismatch');
  if (await nativeCheckpointShaFile(join(folder, 'runtime.jar')) !== runtime.jarSha256
    || !(await lstat(join(folder, 'store.jnl'))).isFile()
    || await readFile(join(folder, 'store.properties'), 'utf8') !== nativeCheckpointProperties(join(folder, 'store.jnl')))
    throw new Error('Checkpoint Edge runtime changed');
  const disk = await statfs(folder);
  if (disk.bavail * disk.bsize <= PROFILE.diskReserveBytes) throw new Error('Checkpoint disk reserve unavailable');
  const inventory = await CheckpointInventory.load(folder);
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort(options.signal.reason);
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  const timer = setTimeout(() => lifetime.abort(new Error('Checkpoint catch-up deadline exceeded')), PROFILE.jobTimeoutMs);
  try { return await startCheckpointEdgeSession(config, runtime.java, sync, lifetime.signal, inventory); }
  finally { clearTimeout(timer); options.signal.removeEventListener('abort', cancel); }
}
