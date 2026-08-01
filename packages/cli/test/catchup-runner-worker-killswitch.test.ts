// Pins the operator kill-switch for the issue #2006 progressive walk.
//
// `DKG_CATCHUP_STOP_ON_PROOF=0` must restore the PREVIOUS behaviour exactly:
// every sync-capable peer contacted, both requested planes pulled from each of
// them, and no early stop — so an operator can back the optimisation out
// without a redeploy if a graph ever lands short. The switch is read once at
// module load, which is why this lives in its own file.
import { describe, expect, it, vi } from 'vitest';
import { CATCHUP_MAX_CONCURRENT_PEER_SYNCS } from '@origintrail-official/dkg-agent';
import type { CatchupJobResult, CatchupRunRequest } from '../src/catchup-runner.js';

vi.hoisted(() => {
  process.env.DKG_CATCHUP_STOP_ON_PROOF = '0';
});

const fakeParentPort = vi.hoisted(() => {
  const messageListeners: Array<(message: any) => void> = [];
  const port = {
    on(event: string, listener: (message: any) => void) {
      if (event === 'message') messageListeners.push(listener);
    },
    onPosted: undefined as ((message: any) => void) | undefined,
    postMessage(message: any) {
      port.onPosted?.(message);
    },
    emitMessage(message: any) {
      for (const listener of messageListeners) listener(message);
    },
  };
  return port;
});

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: fakeParentPort,
}));

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function durableResult() {
  return {
    insertedTriples: 1,
    complete: true,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 1,
    insertedMetaTriples: 0,
    insertedDataTriples: 1,
    bytesReceived: 10,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    deferredBackpressure: 0,
  };
}

function sharedResult() {
  return {
    insertedTriples: 1,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 1,
    insertedMetaTriples: 0,
    insertedDataTriples: 1,
    bytesReceived: 10,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    deferredBackpressure: 0,
  };
}

let nextRunId = 1;

async function runWorkerCatchup(
  request: CatchupRunRequest,
  handler: (method: string, args: unknown[]) => Promise<unknown>,
): Promise<CatchupJobResult> {
  await import('../src/catchup-runner-worker-impl.js');
  const runId = nextRunId++;
  return new Promise<CatchupJobResult>((resolve, reject) => {
    fakeParentPort.onPosted = (message: any) => {
      if (message.type === 'invoke') {
        handler(message.method, message.args).then(
          (result) => fakeParentPort.emitMessage({ type: 'invoke-result', invokeId: message.invokeId, result }),
          (error: unknown) => fakeParentPort.emitMessage({
            type: 'invoke-result',
            invokeId: message.invokeId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      if (message.type === 'run-result' && message.runId === runId) {
        if (message.error) reject(new Error(message.error));
        else resolve(message.result as CatchupJobResult);
      }
    };
    fakeParentPort.emitMessage({ type: 'run', runId, request });
  });
}

describe('catch-up progressive walk kill-switch', () => {
  it('restores the full fan-out over every peer and every requested plane', async () => {
    const peerIds = Array.from({ length: 12 }, (_, i) => `peer-${i}`);
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];
    let inFlight = 0;
    let peak = 0;

    // The curator is first AND cleanly proves both planes on the very first
    // peer — with the switch ON this run would stop after `peer-0`.
    const result = await runWorkerCatchup({ contextGraphId: 'cg-killswitch', includeSharedMemory: true }, async (method, args) => {
      switch (method) {
        case 'prepareCatchup':
          return { preferredPeerId: 'peer-0', isPrivateContextGraph: false, peerIds, connectedPeers: peerIds.length };
        case 'waitForSyncProtocol':
          return true;
        case 'syncDurable': {
          durableCalls.push(args[0] as string);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await delay(2);
          inFlight -= 1;
          return durableResult();
        }
        case 'syncSharedMemory': {
          sharedCalls.push(args[0] as string);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await delay(2);
          inFlight -= 1;
          return sharedResult();
        }
        case 'finalizeCatchup':
          return null;
        default:
          throw new Error(`unexpected invoke: ${method}`);
      }
    });

    expect(durableCalls).toEqual(peerIds);
    expect([...sharedCalls].sort()).toEqual([...peerIds].sort());
    expect(result.peersTried).toBe(peerIds.length);
    expect(result.peersNotAttempted).toBe(0);
    expect(result.dataSynced).toBe(peerIds.length);
    expect(result.sharedMemorySynced).toBe(peerIds.length);
    // The pre-existing sync-storm bound still applies with the switch off.
    expect(peak).toBeLessThanOrEqual(CATCHUP_MAX_CONCURRENT_PEER_SYNCS);
    expect(peak).toBeGreaterThan(1);
  });
});
