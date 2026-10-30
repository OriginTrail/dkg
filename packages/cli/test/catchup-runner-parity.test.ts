import { runWorkerCatchup, durableCatchupResult, sharedCatchupResult } from './helpers/catchup-runner-worker-test-harness.js';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CG = 'runner-parity';
const peers = ['peer-parity-0001', 'peer-parity-0002'];
type Scenario = 'mandatory-deferral' | 'continuation-deferral' | 'repeated-denial';

const previousWait = vi.hoisted(() => {
  const previous = process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS = '0';
  return previous;
});
afterAll(() => {
  if (previousWait === undefined) delete process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  else process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS = previousWait;
});
beforeEach(() => {
  vi.stubEnv('DKG_SWM_CATCHUP_PASS_BUDGET_MS', '60000');
  vi.stubEnv('DKG_SWM_CATCHUP_MAX_PASSES', '4');
});
afterEach(() => vi.unstubAllEnvs());

/** Only transport/storage ports are doubled; both production drivers own their walks and folds. */
function fixture(scenario: Scenario) {
  const calls: string[] = [];
  const rounds = new Map<string, number>();
  const shared = async (peerId: string) => {
    calls.push(peerId);
    const pass = (rounds.get(peerId) ?? 0) + 1;
    rounds.set(peerId, pass);
    const deferred = scenario === 'mandatory-deferral' || (scenario === 'continuation-deferral' && pass > 1);
    return {
      ...sharedCatchupResult(), failedPhases: 1,
      deferredBackpressure: deferred ? 1 : 0,
      deniedPhases: scenario === 'repeated-denial' ? 1 : 0,
      ...(scenario === 'mandatory-deferral' ? {} : { swmCoverage: {
        contextGraphId: CG, peerIdSuffix: peerId.slice(-8), snapshotsResolved: 2, snapshotsTotal: 3,
        manifestComplete: true, missingCount: 1, missingSample: [], materializationFailures: 0,
        fromAuthority: false,
      } }),
    };
  };
  return { calls, shared };
}

function publicResult(result: any) {
  return {
    connectedPeers: result.connectedPeers, syncCapablePeers: result.syncCapablePeers,
    peersTried: result.peersTried, peersResponded: result.peersResponded, peersSucceeded: result.peersSucceeded,
    deferredBackpressure: result.deferredBackpressure, denied: result.denied, deniedPeers: result.deniedPeers,
    dataSynced: result.dataSynced, sharedMemorySynced: result.sharedMemorySynced,
    sharedMemory: result.diagnostics.sharedMemory,
  };
}

describe('production inline/worker catch-up parity', () => {
  it.each<Scenario>(['mandatory-deferral', 'continuation-deferral', 'repeated-denial'])(
    'preserves public diagnostics and distinct-peer counts for %s', async scenario => {
      const inline = fixture(scenario);
      const worker = fixture(scenario);
      const agent = {
        config: {}, log: { info: vi.fn(), warn: vi.fn() }, eventBus: { emit: vi.fn() },
        waitForSyncProtocol: async () => true,
        syncFromPeerDetailed: async () => durableCatchupResult(),
        syncSharedMemoryFromPeerDetailed: inline.shared,
        refreshMetaSyncedFlags: async () => undefined,
        markContextGraphSubscriptionState: vi.fn(),
      } as unknown as DKGAgent;
      const inlineResult = await DKGAgent.prototype.runCatchupOverPeers.call(
        agent, CG, true, peers.map(peer => ({ toString: () => peer })),
        { mode: 'foreground', swmCatchupPassConfig: { budgetMs: 60_000, maxPasses: 4 } },
      );
      const workerResult = await runWorkerCatchup({ contextGraphId: CG, includeSharedMemory: true }, async (method, args) => {
        switch (method) {
          case 'prepareCatchup': return { isPrivateContextGraph: false, peerIds: peers, connectedPeers: peers.length };
          case 'waitForSyncProtocol': return true;
          case 'syncDurable': return durableCatchupResult();
          case 'syncSharedMemory': return worker.shared(String(args[0]));
          default: return null;
        }
      });
      const expectedCalls = scenario === 'mandatory-deferral' ? peers : [...peers, ...peers];
      expect(inline.calls.sort()).toEqual([...expectedCalls].sort());
      expect(worker.calls.sort()).toEqual([...expectedCalls].sort());
      expect(publicResult(workerResult)).toEqual(publicResult(inlineResult));
      expect(workerResult.peersTried).toBe(2);
      expect(workerResult.peersResponded).toBe(2);
      expect(workerResult.peersSucceeded).toBe(0);
      expect(workerResult.deferredBackpressure).toBe(scenario === 'mandatory-deferral' ? 2 : 0);
      expect(workerResult.deniedPeers).toBe(scenario === 'repeated-denial' ? 2 : 0);
      expect(workerResult.diagnostics?.sharedMemory?.deniedPhases).toBe(scenario === 'repeated-denial' ? 4 : 0);
      expect(workerResult.diagnostics?.sharedMemory?.deferredBackpressure).toBe(scenario === 'repeated-denial' ? 0 : 2);
      expect(workerResult.diagnostics?.sharedMemory?.continuationPasses).toBe(scenario === 'mandatory-deferral' ? 0 : 1);
    },
  );
});
