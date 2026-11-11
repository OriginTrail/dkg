import { parentPort, workerData } from 'node:worker_threads';
import { OxigraphStore } from './oxigraph.js';
import { configureStoreGraphCatalogMaxBytes } from '../graph-catalog-internal-limit.js';
import {
  serializeWorkerErrorV1,
  type WorkerResponseV1,
} from '../worker-error-protocol.js';

function respond(response: WorkerResponseV1): void {
  parentPort!.postMessage(response);
}

// The parent process's configured catalog ceiling; DKG_STORE_GRAPH_CATALOG_MAX_BYTES, which the thread inherits, still wins.
if (workerData?.graphCatalogMaxBytes !== undefined) configureStoreGraphCatalogMaxBytes(workerData.graphCatalogMaxBytes);
const store = new OxigraphStore(workerData?.persistPath, { readOnly: workerData?.readOnly === true });

parentPort!.on('message', async (msg: { id: number; method: string; args: unknown[] }) => {
  try {
    const fn = (store as any)[msg.method];
    if (typeof fn !== 'function') {
      respond({
        id: msg.id,
        error: serializeWorkerErrorV1(new Error(`Unknown method: ${msg.method}`)),
      });
      return;
    }
    const result = await fn.apply(store, msg.args);
    respond({ id: msg.id, result });
  } catch (err) {
    respond({
      id: msg.id,
      error: serializeWorkerErrorV1(err),
    });
  }
});
