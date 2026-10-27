// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DKGAgent, openFreshPublicCheckpointEdge, openResumablePublicCheckpointEdge,
  type DKGAgentConfig } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { CHECKPOINT_DAEMON_DIRECTORY, type DaemonPublicCheckpointConfig } from './public-checkpoint-config.js';

type Session = Awaited<ReturnType<typeof openFreshPublicCheckpointEdge>>;
/** Normal daemon registration/start/stop owns the final agent, including its private JVM. */
export async function openDaemonCheckpointAgent(config: DKGAgentConfig, spec: DaemonPublicCheckpointConfig,
  mode: 'fresh' | 'resume', signal: AbortSignal): Promise<Session> {
  if (!config.dataDir || (!config.chainAdapter && !config.chainConfig) || config.nodeRole !== 'edge' || config.storeConfig || config.store)
    throw new Error('Invalid daemon checkpoint profile');
  const home = config.dataDir;
  const edgeConfig = { ...config, dataDir: join(home, CHECKPOINT_DAEMON_DIRECTORY) };
  if (mode === 'resume') return openResumablePublicCheckpointEdge({ config: edgeConfig,
    runtime: spec.runtime, sync: spec.source, signal });
  // Exclusive preparation directory: a failed attempt cannot be replayed automatically.
  const preparationDir = join(home, 'public-checkpoint-preparation');
  await mkdir(preparationDir, { mode: 0o700 });
  const preparing = await DKGAgent.create({ ...config, listenPort: 0, store: new OxigraphStore(),
    dataDir: preparationDir, syncOnConnectEnabled: false, syncReconcilerEnabled: false, vmReconcilerEnabled: false });
  let handoff: Awaited<ReturnType<DKGAgent['preparePublicCheckpointHandoff']>>;
  try {
    await preparing.start();
    handoff = await preparing.preparePublicCheckpointHandoff({ ...spec.source, signal }, spec.runtime);
  } finally { await preparing.stop(); }
  if (!handoff.native) throw new Error('Native checkpoint build did not complete');
  return openFreshPublicCheckpointEdge({ config: edgeConfig, ...handoff, native: handoff.native,
    runtime: spec.runtime, sync: spec.source, signal });
}
