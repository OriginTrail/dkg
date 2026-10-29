import { afterEach, expect, it, vi } from 'vitest';
import { join, relative } from 'node:path';
import { DKGAgent } from '../src/dkg-agent.js';
import { checkpointAgentFixture } from '../test/helpers/public-checkpoint-agent-fixture.js';
import { buildNativeSnapshotCheckpoint } from '../src/snapshot-native-build.js';
import { createFreshPublicCheckpointEdge } from '../src/snapshot-fresh-edge.js';
import { resumePublicCheckpointEdge } from '../src/snapshot-resume-edge.js';
import { openSnapshotNativeStore } from '../src/snapshot-native-store.js';
import * as processes from '../src/snapshot-native-process.js';

afterEach(() => vi.restoreAllMocks());
const runtime = { java: process.env.DKG_PUBLIC_CHECKPOINT_JAVA ?? '', jar: process.env.DKG_PUBLIC_CHECKPOINT_JAR ?? '',
  jarSha256: process.env.DKG_PUBLIC_CHECKPOINT_JAR_SHA256 ?? '' };

it.each(['fresh', 'resume'] as const)('releases the actual JVM and journal when %s network startup fails', async mode => {
  const f = await checkpointAgentFixture();
  const owned: { process: Awaited<ReturnType<typeof processes.startSnapshotNativeProcess>>; closed: boolean }[] = [];
  const realStart = processes.startSnapshotNativeProcess;
  vi.spyOn(processes, 'startSnapshotNativeProcess').mockImplementation(async (...args) => {
    const process = await realStart(...args), record = { process, closed: false };
    owned.push(record);
    void process.closed.then(() => { record.closed = true; }, () => { record.closed = true; });
    return process;
  });
  let edge: DKGAgent | undefined;
  try {
    const prepared = await f.run(relative(process.cwd(), f.directory));
    const signal = AbortSignal.timeout(prepared.manifest.deadline - Date.now());
    const native = await buildNativeSnapshotCheckpoint(prepared, { ...runtime, signal,
      assertInventoryCurrent: async () => { expect((await f.readFresh()).snapshot.inventoryDigest).toBe(prepared.manifest.observation.snapshot.inventoryDigest); } });
    const options = { config: f.config, prepared, native, runtime, sync: f.sync, signal };
    if (mode === 'resume') {
      edge = (await createFreshPublicCheckpointEdge(options)).agent;
      await edge.stop(); edge = undefined;
    }
    const before = owned.length;
    vi.spyOn(DKGAgent.prototype, 'start').mockRejectedValueOnce(new Error('network startup failed'));
    await expect((mode === 'fresh' ? createFreshPublicCheckpointEdge : resumePublicCheckpointEdge)(options))
      .rejects.toThrow('network startup failed');
    expect(owned.slice(before)).toHaveLength(1);
    expect(owned.slice(before).every(record => record.closed)).toBe(true);
    // A new real server must acquire the same journal lock after the failure returns.
    const folder = join(f.config.dataDir, 'checkpoint-store');
    const reopened = await openSnapshotNativeStore({ ...runtime, folder,
      properties: join(folder, 'store.properties'), log: join(folder, 'reopened.log'), signal });
    await reopened.close();
  } finally {
    await edge?.stop();
    await Promise.all(owned.map(record => record.process.stop()));
    await f.core.stop();
  }
}, 30_000);
