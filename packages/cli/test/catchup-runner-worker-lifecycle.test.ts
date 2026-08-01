// The daemon's subscribe job awaits `catchupRunner.run(...)` in a
// fire-and-forget async IIFE with no timeout of its own. `close()` terminates
// the Worker, which emits 'exit' — never 'error' — so before this fix a pending
// run promise was simply never settled and the job stayed `running` with no
// `finishedAt` for the rest of the process's life. Issue #2006 makes that
// reachable routinely, because a walk can be in flight for much longer.
import { describe, expect, it } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { createCatchupRunner } from '../src/catchup-runner.js';

function hangingAgent(): DKGAgent {
  return {
    isPrivateContextGraph: async () => false,
    resolvePreferredSyncPeerId: async () => undefined,
    ensurePeerConnected: async () => {},
    // The worker's first RPC never settles, so the run stays in `pendingRuns`.
    primeCatchupConnections: () => new Promise<void>(() => {}),
    selectCatchupPeers: (peers: unknown[]) => peers,
    node: { libp2p: { getConnections: () => [] } },
  } as unknown as DKGAgent;
}

describe('WorkerCatchupRunner lifecycle', () => {
  it('rejects an in-flight run when the worker exits instead of leaving it pending forever', async () => {
    const runner = createCatchupRunner(hangingAgent());
    const run = runner.run({ contextGraphId: 'cg-hang', includeSharedMemory: false });
    const settled = run.then(() => 'resolved' as const, () => 'rejected' as const);

    // Give the worker a moment to boot and issue its first invoke.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runner.close();

    await expect(Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 5_000)),
    ])).resolves.toBe('rejected');
  }, 30_000);
});
