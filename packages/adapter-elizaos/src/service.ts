/**
 * DKGService — manages the DKG agent lifecycle within ElizaOS.
 *
 * Initialized once per ElizaOS agent runtime. Reads config from runtime
 * settings (DKG_*), starts a DKGAgent, and publishes the agent profile.
 */
import { DKGAgent, type DKGAgentConfig } from '@origintrail-official/dkg-agent';
import type { IAgentRuntime, Service } from './types.js';

let agentInstance: DKGAgent | null = null;

export function getAgent(): DKGAgent | null {
  return agentInstance;
}

function requireAgent(): DKGAgent {
  if (!agentInstance) throw new Error('DKG node not started — is DKGService initialized?');
  return agentInstance;
}

export { requireAgent };

export const dkgService: Service = {
  name: 'dkg-node',

  async initialize(runtime: IAgentRuntime): Promise<void> {
    if (agentInstance) return;

    const relayPeersRaw = runtime.getSetting('DKG_RELAY_PEERS');
    const bootstrapRaw = runtime.getSetting('DKG_BOOTSTRAP_PEERS');

    const config: DKGAgentConfig = {
      name: runtime.character?.name ?? runtime.getSetting('DKG_AGENT_NAME') ?? 'elizaos-agent',
      framework: 'ElizaOS',
      description: runtime.getSetting('DKG_AGENT_DESCRIPTION'),
      dataDir: runtime.getSetting('DKG_DATA_DIR') ?? '.dkg/elizaos',
      listenPort: runtime.getSetting('DKG_LISTEN_PORT')
        ? parseInt(runtime.getSetting('DKG_LISTEN_PORT')!, 10)
        : undefined,
      relayPeers: relayPeersRaw ? relayPeersRaw.split(',').map(s => s.trim()) : undefined,
      bootstrapPeers: bootstrapRaw ? bootstrapRaw.split(',').map(s => s.trim()) : undefined,
    };

    agentInstance = await DKGAgent.create(config);
    await agentInstance.start();
    await agentInstance.publishProfile();
  },

  async cleanup(): Promise<void> {
    if (!agentInstance) return;
    await agentInstance.stop();
    agentInstance = null;
  },
};
