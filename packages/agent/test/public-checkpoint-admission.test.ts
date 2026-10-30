import { afterEach, expect, it, vi } from 'vitest';
import * as pacing from '../src/public-snapshot-exact-pacing.js';
import * as native from '../src/snapshot-native-build.js';
import { DKGAgent } from '../src/dkg-agent.js';
import { checkpointAgentFixture } from './helpers/public-checkpoint-agent-fixture.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('retains fresh native-preparation observations through a real single-Core admission refusal', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('DKG_PUBLIC_CHECKPOINT_JAVA', '/fixture/java');
  vi.stubEnv('DKG_PUBLIC_CHECKPOINT_JAR', '/fixture/blazegraph.jar');
  vi.stubEnv('DKG_PUBLIC_CHECKPOINT_JAR_SHA256', 'a'.repeat(64));
  const wait = vi.spyOn(pacing, 'waitForPublicSnapshotRetry').mockImplementation(async (until, signal, current) => {
    signal.throwIfAborted(); current(); expect(until - Date.now()).toBe(60_000);
    vi.setSystemTime(until); current();
  });
  const builder = vi.spyOn(native, 'buildNativeSnapshotCheckpoint').mockImplementation(async (_prepared, options) => {
    await options.assertInventoryCurrent(); // Actual production pre-build and post-audit callbacks.
    await options.assertInventoryCurrent();
    return {} as never; // Native loading itself is covered by the live integration test.
  });
  const f = await checkpointAgentFixture(); let edge: DKGAgent | undefined;
  const builds = vi.spyOn(f.config.chainAdapter, 'readPublicGraphSnapshot');
  try {
    edge = await DKGAgent.create(f.config); await edge.start();
    await expect(edge.preparePublicGraphCheckpoint({ ...f.sync, mode: 'core-cache' }, true))
      .resolves.toMatchObject({ assets: 3, current: false, activeStoreChanged: false });
    expect(builder).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledOnce();
    expect(builds).toHaveBeenCalledTimes(4);
  } finally { await edge?.stop(); await f.core.stop(); }
}, 30_000);
