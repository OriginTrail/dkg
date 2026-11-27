import { afterEach, expect, it, vi } from 'vitest';
import { join, relative } from 'node:path';
import { DKGAgent } from '../src/dkg-agent.js';
import { checkpointAgentFixture } from '../test/helpers/public-checkpoint-agent-fixture.js';
import { buildNativeSnapshotCheckpoint } from '../src/snapshot-native-build.js';
import { createFreshPublicCheckpointEdge, openFreshPublicCheckpointEdge } from '../src/snapshot-fresh-edge.js';
import { resumePublicCheckpointEdge, openResumablePublicCheckpointEdge } from '../src/snapshot-resume-edge.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { VmReconcileSchedulingRuntime } from '../src/chain-reconciler.js';
import { VmReconcileShutdownTimeoutError } from '../src/vm-reconcile-service.js';
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

it.each(['fresh', 'resume'] as const)('keeps the %s JVM usable during shutdown quarantine and releases it after retry', async mode => {
  const f = await checkpointAgentFixture();
  const originalTimeout = DKGAgentBase.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS;
  let session: Awaited<ReturnType<typeof openFreshPublicCheckpointEdge>> | undefined;
  let initial: DKGAgent | undefined;
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  try {
    const prepared = await f.run(relative(process.cwd(), f.directory));
    const signal = AbortSignal.timeout(prepared.manifest.deadline - Date.now());
    const native = await buildNativeSnapshotCheckpoint(prepared, { ...runtime, signal,
      assertInventoryCurrent: async () => { expect((await f.readFresh()).snapshot.inventoryDigest).toBe(prepared.manifest.observation.snapshot.inventoryDigest); } });
    const options = { config: f.config, prepared, native, runtime, sync: f.sync, signal };
    if (mode === 'resume') {
      initial = (await createFreshPublicCheckpointEdge(options)).agent;
      await initial.stop(); initial = undefined;
    }
    session = await (mode === 'fresh' ? openFreshPublicCheckpointEdge : openResumablePublicCheckpointEdge)(options);
    await session.agent.start(); await session.complete();
    const scheduling = new VmReconcileSchedulingRuntime(async () => active, () => undefined);
    Object.assign(session.agent, { vmReconcileScheduling: scheduling });
    void scheduling.dispatcher.triggerManual('held-native-retirement');
    await new Promise(resolve => setTimeout(resolve, 0));
    // Exercise the real retirement timeout within this test's existing deadline.
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: 20 });
    await expect(session.close()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);
    const readable = await session.agent.store.query('ASK { ?s ?p ?o }');
    expect(readable).toEqual({ type: 'boolean', value: true });
    release();
    await expect(session.close()).resolves.toBeUndefined();
    const folder = join(f.config.dataDir, 'checkpoint-store');
    const reopened = await openSnapshotNativeStore({ ...runtime, folder,
      properties: join(folder, 'store.properties'), log: join(folder, 'after-retirement.log'), signal });
    try { expect(await reopened.query('ASK { ?s ?p ?o }')).toEqual(readable); }
    finally { await reopened.close(); }
  } finally {
    release();
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: originalTimeout });
    try { await session?.agent.stop(); await initial?.stop(); }
    finally { session?.dispose(); await f.core.stop(); }
  }
}, 30_000);
