import { parentPort, workerData } from 'node:worker_threads';
import { OxigraphStore } from './oxigraph.js';
import { serializeWorkerErrorV1 } from '../worker-error-protocol.js';

const store = new OxigraphStore(workerData?.persistPath);

parentPort!.on('message', async (msg: { id: number; method: string; args: unknown[] }) => {
  try {
    const fn = (store as any)[msg.method];
    if (typeof fn !== 'function') {
      parentPort!.postMessage({
        id: msg.id,
        error: `Unknown method: ${msg.method}`,
      });
      return;
    }
    const result = await fn.apply(store, msg.args);
    parentPort!.postMessage({ id: msg.id, result });
  } catch (err) {
    const envelope = serializeWorkerErrorV1(err);
    parentPort!.postMessage({
      id: msg.id,
      error: envelope.message,
      errorName: envelope.name,
      ...(envelope.code === undefined ? {} : { errorCode: envelope.code }),
    });
  }
});
