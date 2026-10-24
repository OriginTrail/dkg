// SPDX-License-Identifier: Apache-2.0

import { Worker } from 'node:worker_threads';

const worker = new Worker(
  new URL('../dist/catchup-runner-worker-impl.js', import.meta.url),
);
let timeout;

try {
  await new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('packaged catch-up worker did not load before timeout'));
    }, 10_000);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      reject(new Error(
        `packaged catch-up worker exited before its first invocation (code ${code})`,
      ));
    });
    worker.on('message', (message) => {
      if (message?.type !== 'invoke') return;
      if (message.method !== 'prepareCatchup') {
        reject(new Error(
          `packaged catch-up worker emitted unexpected first invocation: ${message.method}`,
        ));
        return;
      }
      resolve();
    });
    worker.postMessage({
      type: 'run',
      runId: 1,
      request: {
        contextGraphId: 'package-boundary-smoke',
        includeSharedMemory: true,
      },
    });
  });
} finally {
  clearTimeout(timeout);
  await worker.terminate();
}
