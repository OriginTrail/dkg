import type { GraphWriteGenTracker, GraphWriteScope } from './graph-write-gen.js';

export async function runTrackedStoreWrite<T>(
  writeGen: GraphWriteGenTracker,
  scope: GraphWriteScope,
  work: () => Promise<T>,
): Promise<T> {
  const lifecycle = writeGen.beginWrite(scope);
  try {
    return await work();
  } finally {
    // One worker message is transactional; a returned error means it settled
    // without a partial write, while success publishes the committed state.
    lifecycle.settle();
  }
}
