// SPDX-License-Identifier: Apache-2.0
import { encodeSnapshotBootstrapRecord } from './snapshot-bootstrap-record.js';
import { CheckpointInventory } from './snapshot-checkpoint-inventory.js';
import { nativeCheckpointProperties } from './snapshot-native-properties.js';
import { startCheckpointEdgeSession } from './snapshot-checkpoint-edge-session.js';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, stat, statfs } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { DKGAgentConfig } from './dkg-agent-types.js';
import { assertCheckpointInventoryUnchanged } from './public-snapshot-checkpoint.js';
import type { PreparedSnapshotCheckpoint, VerifiedNativeSnapshotCheckpoint } from './snapshot-checkpoint-contract.js';
import { nativeCheckpointShaFile } from './snapshot-checkpoint-files.js';
import { CHECKPOINT_PROFILE as PROFILE } from './snapshot-checkpoint-profile.js';
import { normalizePublicSnapshotSyncOptions, type PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { writeCheckpointFile, syncCheckpointDirectory } from './snapshot-checkpoint-files.js';

interface FreshCheckpointEdgeOptions {
  config: DKGAgentConfig & { dataDir: string; chainAdapter: ChainAdapter };
  prepared: PreparedSnapshotCheckpoint;
  native: VerifiedNativeSnapshotCheckpoint;
  runtime: { java: string; jar: string; jarSha256: string };
  sync: PublicSnapshotSyncOptions;
  signal: AbortSignal;
}

/**
 * Explicit SDK bootstrap for a NEW Edge. Never changes an existing Edge's
 * endpoint, config, credentials, private/community data, or original journal.
 * The returned agent has also completed ordinary authenticated catch-up. Its
 * stop() owns the copied journal's local server; failed attempts stay on disk.
 */
export async function createFreshPublicCheckpointEdge(options: FreshCheckpointEdgeOptions) {
  const { config, prepared, native, runtime } = options;
  const snapshot = prepared.manifest.observation.snapshot;
  const sync = normalizePublicSnapshotSyncOptions(options.sync);
  if (!isAbsolute(config.dataDir) || config.store || config.storeConfig || config.nodeRole === 'core'
    || config.chainAdapter.chainId !== snapshot.chainId || config.chainAdapter.deploymentId !== snapshot.deploymentId
    || sync.contextGraphId !== snapshot.contextGraphId || sync.onChainId !== snapshot.onChainId
    || sync.mode !== prepared.manifest.observation.mode) throw new Error('Fresh checkpoint Edge binding mismatch');
  if (!isAbsolute(runtime.java) || !isAbsolute(runtime.jar) || runtime.jarSha256 !== native.runtimeSha256
    || native.state !== 'verified-unpublished' || !native.fullReadback
    || native.inventoryDigest !== snapshot.inventoryDigest || native.journal !== join(prepared.directory, 'native/store.jnl'))
    throw new Error('Invalid native checkpoint handoff');
  const remaining = prepared.manifest.deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > PROFILE.jobTimeoutMs) throw new Error('Checkpoint job deadline exceeded');
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort(options.signal.reason);
  options.signal.throwIfAborted(); options.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => lifetime.abort(new Error('Checkpoint job deadline exceeded')), remaining);
  let agent: import('./dkg-agent.js').DKGAgent | undefined;
  try {
    if (await nativeCheckpointShaFile(runtime.jar) !== runtime.jarSha256
      || await nativeCheckpointShaFile(native.journal) !== native.journalSha256) throw new Error('Native checkpoint handoff hash mismatch');
    lifetime.signal.throwIfAborted();
    // Atomic exclusive creation is the eligibility check. There is no overwrite
    // option: upgrades and previously initialized directories use ordinary sync.
    await mkdir(config.dataDir, { mode: 0o700 });
    const folder = join(config.dataDir, 'checkpoint-store'); await mkdir(folder, { mode: 0o700 });
    const disk = await statfs(folder);
    if (disk.bavail * disk.bsize <= PROFILE.diskReserveBytes + (await stat(native.journal)).size)
      throw new Error('Insufficient space for the fresh Edge journal');
    const pinnedJar = join(folder, 'runtime.jar');
    await copyFile(runtime.jar, pinnedJar, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    if (await nativeCheckpointShaFile(pinnedJar) !== runtime.jarSha256) throw new Error('Native runtime copy mismatch');
    const journal = join(folder, 'store.jnl');
    await copyFile(native.journal, journal, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const file = await open(journal, 'r+'); try { await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
    if (await nativeCheckpointShaFile(journal) !== native.journalSha256) throw new Error('Checkpoint copy failed verification');
    // Only locally generated pinned loader properties can cross the handoff.
    const properties = await readFile(join(prepared.directory, 'native/load.properties'), 'utf8');
    if (properties !== nativeCheckpointProperties(native.journal)) throw new Error('Checkpoint properties changed');
    const props = nativeCheckpointProperties(journal);
    await writeCheckpointFile(join(folder, 'store.properties'), props);
    await syncCheckpointDirectory(folder);
    assertCheckpointInventoryUnchanged(prepared.manifest.observation, prepared.manifest.freshObservation);
    const inventory = await CheckpointInventory.create(folder, prepared.manifest.freshObservation);
    const session = await startCheckpointEdgeSession(config, runtime.java, sync, lifetime.signal, inventory);
    agent = session.agent;
    const { result } = session;
    lifetime.signal.throwIfAborted();
    await writeCheckpointFile(join(folder, 'BOOTSTRAP-COMPLETE.json'), encodeSnapshotBootstrapRecord({ version: 1,
      chainId: snapshot.chainId, deploymentId: snapshot.deploymentId, contextGraphId: snapshot.contextGraphId,
      onChainId: snapshot.onChainId, mode: sync.mode,
      initialJournalSha256: native.journalSha256, runtimeSha256: runtime.jarSha256,
      result: { ...result, current: true, completeAsOfSnapshot: true } }));
    await syncCheckpointDirectory(folder);
    lifetime.signal.throwIfAborted();
    return { agent, result, dataDir: config.dataDir };
  } catch (error) {
    await agent?.stop();
    throw error;
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', cancel);
  }
}
