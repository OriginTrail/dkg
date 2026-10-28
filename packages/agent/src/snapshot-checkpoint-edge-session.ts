// SPDX-License-Identifier: Apache-2.0
import { attachCheckpointInventory, type CheckpointInventory } from './snapshot-checkpoint-inventory.js';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { BlazegraphStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { DKGAgentConfig } from './dkg-agent-types.js';
import type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { openSnapshotNativeStore } from './snapshot-native-store.js';

export type CheckpointEdgeConfig = DKGAgentConfig & { dataDir: string; chainAdapter: ChainAdapter };

/** Starts only this Edge's private store; normal snapshot recovery determines current coverage. */
export async function startCheckpointEdgeSession(config: CheckpointEdgeConfig, java: string,
  sync: PublicSnapshotSyncOptions, signal: AbortSignal, inventory: CheckpointInventory) {
  if (Math.min(totalmem(), process.constrainedMemory() || Infinity) < 4 * 2 ** 30)
    throw new Error('Native bootstrap requires a 4 GiB memory allowance; use incremental recovery');
  signal.throwIfAborted();
  const folder = join(config.dataDir, 'checkpoint-store');
  let agent: import('./dkg-agent.js').DKGAgent | undefined;
  let store: BlazegraphStore | undefined;
  try {
    store = await openSnapshotNativeStore({ java, jar: join(folder, 'runtime.jar'),
      properties: join(folder, 'store.properties'), folder, log: join(folder, `session-${crypto.randomUUID()}.log`), signal });
    const { DKGAgent } = await import('./dkg-agent.js');
    agent = await DKGAgent.create({ ...config, nodeRole: 'edge', store });
    attachCheckpointInventory(agent, inventory);
    await agent.start(); signal.throwIfAborted();
    await agent.waitForPublicCheckpointStartup(sync.contextGraphId, signal);
    const result = await agent.syncPublicGraphSnapshot({ ...sync, transport: 'exact', signal });
    signal.throwIfAborted();
    if (!result.current) throw new Error('Checkpoint Edge did not reach current coverage');
    return { agent, result, dataDir: config.dataDir };
  } catch (error) {
    try { await agent?.stop(); } finally { await store?.close(); }
    throw error;
  }
}
