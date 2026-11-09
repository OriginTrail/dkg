import { afterEach, expect, it, vi } from 'vitest';
import * as pacing from '../src/public-snapshot-exact-pacing.js';
import { DKGAgent } from '../src/dkg-agent.js';
import { checkpointAgentFixture } from '../test/helpers/public-checkpoint-agent-fixture.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('prepares a native checkpoint through one real Core responder within its two-build admission window', async () => {
  // Only wall-clock waiting is virtual. Agents, protocol, admission, verification,
  // native loading and readback are real; production deadlines remain unchanged.
  vi.useFakeTimers({ toFake: ['Date'] });
  const wait = vi.spyOn(pacing, 'waitForPublicSnapshotRetry').mockImplementation(async (until, signal, current) => {
    signal.throwIfAborted(); current();
    expect(until - Date.now()).toBe(60_000);
    vi.setSystemTime(until); current();
  });
  const f = await checkpointAgentFixture(); let edge: DKGAgent | undefined;
  const build = vi.spyOn(f.config.chainAdapter, 'readPublicGraphSnapshot');
  try {
    edge = await DKGAgent.create(f.config); await edge.start();
    const result = await edge.preparePublicGraphCheckpoint({ ...f.sync, mode: 'core-cache' }, true);
    expect(result).toMatchObject({ assets: 3, current: false, committed: 0, activeStoreChanged: false,
      native: { fullReadback: true, assets: 3, state: 'verified-unpublished' } });
    expect(wait).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledTimes(4); // Initial, post-verification, pre-build, post-audit.
  } finally { await edge?.stop(); await f.core.stop(); }
}, 30_000);
