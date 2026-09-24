import { parentPort, workerData } from 'node:worker_threads';
import {
  createChainIndexReadWorkerHandler,
  yieldChainIndexReadWorker,
} from './chain-index-read-worker-handler.js';

if (parentPort === null) throw new Error('Chain-index reader requires a worker');
const port = parentPort;
const handler = createChainIndexReadWorkerHandler({
  dbPath: workerData.dbPath,
  postMessage: (response) => port.postMessage(response),
  checkpoint: yieldChainIndexReadWorker,
});
port.on('message', handler.handle);
port.on('close', handler.close);
port.postMessage({ type: 'ready' });
