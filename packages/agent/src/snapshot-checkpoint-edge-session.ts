// SPDX-License-Identifier: Apache-2.0
import { attachCheckpointInventory, type CheckpointInventory } from './snapshot-checkpoint-inventory.js';
import { assertCheckpointMemory } from './snapshot-checkpoint-profile.js';
import { join } from 'node:path';
import type { BlazegraphStore } from '@origintrail-official/dkg-storage';
import { operationalSignerSourceOf } from './agent-chain-signer-source.js';
import { buildEvmDeploymentId } from '@origintrail-official/dkg-chain';
import type { DKGAgentConfig } from './dkg-agent-types.js';
import type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { openSnapshotNativeStore } from './snapshot-native-store.js';

export type CheckpointEdgeConfig = DKGAgentConfig & { dataDir: string };

/** Resolve the same deployment identity as the normal EVM adapter, without making RPC calls. */
export function checkpointChainBinding(config: CheckpointEdgeConfig) {
  if (config.chainAdapter) return { chainId: config.chainAdapter.chainId, deploymentId: config.chainAdapter.deploymentId };
  const chain = config.chainConfig;
  if (!chain?.chainId || !chain.hubAddress || !operationalSignerSourceOf(chain)) throw new Error('Checkpoint requires an explicit chain deployment');
  return { chainId: chain.chainId, deploymentId: buildEvmDeploymentId(chain as { chainId: string; hubAddress: string }) };
}

/** Starts only this Edge's private store; normal snapshot recovery determines current coverage. */
export async function openCheckpointEdgeSession(config: CheckpointEdgeConfig, java: string,
  sync: PublicSnapshotSyncOptions, signal: AbortSignal, inventory: CheckpointInventory) {
  assertCheckpointMemory();
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
    const ownedAgent = agent;
    const ownedStore = store;
    let closing: Promise<void> | undefined;
    // A successful stop may be a no-op when start() never succeeded; the session
    // still owns that store. A rejected stop must retain dependencies for retry.
    const close = () => closing ??= (async () => {
      await ownedAgent.stop();
      await ownedStore.close();
    })().catch(error => { closing = undefined; throw error; });
    return { agent: ownedAgent, dataDir: config.dataDir, close, async complete() {
      signal.throwIfAborted();
      await ownedAgent.waitForPublicCheckpointStartup(sync.contextGraphId, signal);
      const result = await ownedAgent.syncPublicGraphSnapshot({ ...sync, transport: 'exact', signal });
      signal.throwIfAborted();
      if (!result.current) throw new Error('Checkpoint Edge did not reach current coverage');
      return result;
    } };
  } catch (error) {
    try { await agent?.stop(); } finally { await store?.close(); }
    throw error;
  }
}

/** SDK convenience; daemon callers register their lifecycle handlers before starting. */
export async function startCheckpointEdgeSession(config: CheckpointEdgeConfig, java: string,
  sync: PublicSnapshotSyncOptions, signal: AbortSignal, inventory: CheckpointInventory) {
  const session = await openCheckpointEdgeSession(config, java, sync, signal, inventory);
  try {
    await session.agent.start();
    return { agent: session.agent, dataDir: session.dataDir, result: await session.complete() };
  } catch (error) { await session.close(); throw error; }
}
