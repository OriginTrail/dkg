import { vi } from 'vitest';
import type { CatchupJobResult, CatchupRunRequest } from '../../src/catchup-runner.js';

export type CatchupWorkerInvokeHandler = (
  method: string,
  args: unknown[],
) => Promise<unknown>;

// The worker implementation binds parentPort at module load. Keeping this mock
// in one helper gives every worker suite the same RPC boundary and prevents a
// future protocol change from being patched into several copied harnesses.
const fakeCatchupParentPort = vi.hoisted(() => {
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
  parentPort: fakeCatchupParentPort,
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
