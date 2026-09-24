import { parentPort, workerData } from 'node:worker_threads';
import {
  createChainIndexReadWorkerHandler,
  yieldChainIndexReadWorker,
} from '../../dist/daemon/worker/chain-index-read-worker-handler.js';

if (parentPort === null) throw new Error('Chain-index reader test requires a worker');
const port = parentPort;
const barrier = new Int32Array(workerData.testDecodeBarrier);
const handler = createChainIndexReadWorkerHandler({
  dbPath: workerData.dbPath,
  postMessage: (response) => port.postMessage(response),
  checkpoint: async (progress) => {
    // Queue parent messages at the first batch without processing any of them.
    // After release, interleaving still depends on the real production yield.
    if (progress.method === 'ordinal' && Atomics.compareExchange(barrier, 0, 0, 1) === 0) {
      port.postMessage({ type: 'test-decode-batch', ...progress });
      Atomics.wait(barrier, 0, 1, 10_000);
    }
    await yieldChainIndexReadWorker();
  },
});
port.on('message', handler.handle);
port.on('close', handler.close);
port.postMessage({ type: 'ready' });
