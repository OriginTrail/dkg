// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BlazegraphStore } from '@origintrail-official/dkg-storage';
import { startSnapshotNativeProcess } from './snapshot-native-process.js';

async function choosePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('No local checkpoint port');
  return address.port;
}

class OwnedNativeStore extends BlazegraphStore {
  private closing?: Promise<void>;
  constructor(endpoint: string, private readonly stopProcess: () => Promise<void>) { super(endpoint); }
  override close(): Promise<void> {
    return this.closing ??= (async () => { try { await super.close(); } finally { await this.stopProcess(); } })();
  }
}

/** Returns a ready client whose idempotent close owns physical JVM shutdown. */
export async function openSnapshotNativeStore(options: {
  java: string; jar: string; properties: string; folder: string; log: string; signal: AbortSignal;
}): Promise<BlazegraphStore> {
  const { signal } = options;
  signal.throwIfAborted();
  const port = await choosePort();
  const owned = await startSnapshotNativeProcess(options.java, ['-Xms256m', '-Xmx3g',
    `-XX:ActiveProcessorCount=${Math.min(4, availableParallelism())}`, '-Djetty.host=127.0.0.1',
    `-Djetty.port=${port}`, `-Dbigdata.propertyFile=${options.properties}`, '-jar', options.jar],
  options.folder, options.log, signal);
  try {
    // Preserve the existing 60 attempts, one-second request bound and one-second pacing.
    for (let i = 0; i < 60; i++) {
      owned.assertRunning();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/blazegraph/status`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        });
        await response.body?.cancel();
        if (response.ok) {
          owned.assertRunning();
          return new OwnedNativeStore(`http://127.0.0.1:${port}/blazegraph/sparql`, () => owned.stop());
        }
      } catch { signal.throwIfAborted(); }
      await delay(1000, undefined, { signal });
    }
    throw new Error('Checkpoint store readiness deadline exceeded');
  } catch (error) { await owned.stop(); throw error; }
}
