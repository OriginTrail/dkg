import { parentPort, workerData } from 'node:worker_threads';
import { OxigraphStore } from './oxigraph.js';
import { structuredMutationPreDispatchRefusalCode } from '../structured-mutation/refusal-internal.js';

const store = new OxigraphStore(workerData?.persistPath);

parentPort!.on('message', async (msg: { id: number; method: string; args: unknown[] }) => {
  try {
    const fn = (store as any)[msg.method];
    if (typeof fn !== 'function') {
      parentPort!.postMessage({ id: msg.id, error: { message: `Unknown method: ${msg.method}` } });
      return;
    }
    const result = await fn.apply(store, msg.args);
    parentPort!.postMessage({ id: msg.id, result });
  } catch (err) {
    const code = structuredMutationPreDispatchRefusalCode(err);
    parentPort!.postMessage({
      id: msg.id,
      error: {
        message: err instanceof Error ? err.message : String(err),
        ...(code === undefined ? {} : { code }),
      },
    });
  }
});
