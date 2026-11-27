import { vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { CatchupJobResult, CatchupRunRequest } from '../../src/catchup-runner.js';

export type CatchupWorkerInvokeHandler = (
  method: string,
  args: unknown[],
) => Promise<unknown>;

// The worker implementation binds parentPort at module load. Keeping this mock
// in one helper gives every worker suite the same RPC boundary and prevents a
// future protocol change from being patched into several copied harnesses.
const { fakeCatchupParentPort, InProcessCatchupWorker } = vi.hoisted(() => {
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

  /**
   * The daemon runner's `Worker`, run in this thread against the fake
   * `parentPort` above. Messages are structured-cloned and delivered on a later
   * microtask in both directions, like the real thread boundary.
   */
  class InProcessWorker {
    readonly #listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor(_path: string) {
      port.onPosted = (message: any) => {
        const copy = structuredClone(message);
        queueMicrotask(() => this.#emit('message', copy));
      };
    }

    on(event: string, listener: (...args: any[]) => void) {
      this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    }

    postMessage(message: any) {
      const copy = structuredClone(message);
      queueMicrotask(() => port.emitMessage(copy));
    }

    async terminate() {
      this.#emit('exit', 1);
      return 1;
    }

    #emit(event: string, ...args: any[]) {
      for (const listener of this.#listeners.get(event) ?? []) listener(...args);
    }
  }

  return { fakeCatchupParentPort: port, InProcessCatchupWorker: InProcessWorker };
});

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: fakeCatchupParentPort,
  Worker: InProcessCatchupWorker,
}));

export function durableCatchupResult() {
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

export function sharedCatchupResult() {
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

export async function runWorkerCatchup(
  request: CatchupRunRequest,
  handler: CatchupWorkerInvokeHandler,
): Promise<CatchupJobResult> {
  await import('../../src/catchup-runner-worker-impl.js');
  const runId = nextRunId++;
  return new Promise<CatchupJobResult>((resolve, reject) => {
    fakeCatchupParentPort.onPosted = (message: any) => {
      if (message.type === 'invoke') {
        handler(message.method, message.args).then(
          (result) => fakeCatchupParentPort.emitMessage({
            type: 'invoke-result',
            invokeId: message.invokeId,
            result,
          }),
          (error: unknown) => fakeCatchupParentPort.emitMessage({
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
    fakeCatchupParentPort.emitMessage({ type: 'run', runId, request });
  });
}

/**
 * Run one catch-up through the daemon's real parent-side bridge
 * (`createCatchupRunner`) and the real worker, doubling only the agent. Use it
 * when the host's own decisions are under test, not a stubbed invoke handler.
 *
 * Import this helper before any module that loads `src/catchup-runner.ts`, so
 * that module binds the in-process `Worker` above.
 */
export async function runCatchupThroughBridge(
  agent: DKGAgent,
  request: Pick<CatchupRunRequest, 'contextGraphId' | 'includeSharedMemory'>,
): Promise<CatchupJobResult> {
  await import('../../src/catchup-runner-worker-impl.js');
  const { createCatchupRunner } = await import('../../src/catchup-runner.js');
  const runner = createCatchupRunner(agent);
  try {
    return await runner.run(request);
  } finally {
    await runner.close();
  }
}
