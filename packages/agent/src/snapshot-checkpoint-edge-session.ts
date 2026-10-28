// SPDX-License-Identifier: Apache-2.0
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { BlazegraphStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { DKGAgentConfig } from './dkg-agent-types.js';
import type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { chooseCheckpointAuditPort } from './snapshot-native-build.js';
import { startSnapshotNativeProcess } from './snapshot-native-process.js';

export type CheckpointEdgeConfig = DKGAgentConfig & { dataDir: string; chainAdapter: ChainAdapter };

/** Starts only this Edge's private store; normal snapshot recovery determines current coverage. */
export async function startCheckpointEdgeSession(config: CheckpointEdgeConfig, java: string,
  sync: PublicSnapshotSyncOptions, signal: AbortSignal) {
  if (Math.min(totalmem(), process.constrainedMemory() || Infinity) < 4 * 2 ** 30)
    throw new Error('Native bootstrap requires a 4 GiB memory allowance; use incremental recovery');
  signal.throwIfAborted();
  const folder = join(config.dataDir, 'checkpoint-store');
  const port = await chooseCheckpointAuditPort();
  const owned = await startSnapshotNativeProcess(java, ['-Xms256m', '-Xmx3g',
    `-XX:ActiveProcessorCount=${Math.min(4, availableParallelism())}`, '-Djetty.host=127.0.0.1',
    `-Djetty.port=${port}`, `-Dbigdata.propertyFile=${join(folder, 'store.properties')}`,
    '-jar', join(folder, 'runtime.jar')], folder, join(folder, `session-${crypto.randomUUID()}.log`), signal);
  let agent: import('./dkg-agent.js').DKGAgent | undefined;
  let store: BlazegraphStore | undefined;
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      owned.assertRunning();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/blazegraph/status`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        });
        await response.body?.cancel();
        if (response.ok) { ready = true; break; }
      } catch { signal.throwIfAborted(); }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('Checkpoint store readiness deadline exceeded');
    store = new BlazegraphStore(`http://127.0.0.1:${port}/blazegraph/sparql`);
    const closeStore = store.close.bind(store);
    store.close = async () => { try { await closeStore(); } finally { await owned.stop(); } };
    const { DKGAgent } = await import('./dkg-agent.js');
    agent = await DKGAgent.create({ ...config, nodeRole: 'edge', store });
    await agent.start(); signal.throwIfAborted();
    await agent.waitForPublicCheckpointStartup(sync.contextGraphId, signal);
    const result = await agent.syncPublicGraphSnapshot({ ...sync, transport: 'exact', signal });
    signal.throwIfAborted();
    if (!result.current) throw new Error('Checkpoint Edge did not reach current coverage');
    return { agent, result, dataDir: config.dataDir };
  } catch (error) {
    try { await agent?.stop(); } finally { await Promise.allSettled([store?.close(), owned.stop()]); }
    throw error;
  }
}
