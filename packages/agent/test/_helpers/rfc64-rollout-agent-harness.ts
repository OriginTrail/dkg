import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeNetworkId,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import { DKGAgent } from '../../src/index.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../../src/rfc64/open-catalog-policy-v1.js';
import type { Rfc64PublicCatalogActivationInputV1 } from
  '../../src/rfc64/public-catalog-activation-config-v1.js';

export const RFC64_ROLLOUT_AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
export const RFC64_ROLLOUT_AUTHOR = RFC64_ROLLOUT_AUTHOR_WALLET.address
  .toLowerCase() as EvmAddressV1;
export const RFC64_ROLLOUT_NETWORK_ID = 'otp:20430' as NetworkIdV1;
export const RFC64_ROLLOUT_CONTEXT_GRAPH_ID = (
  '0x1111111111111111111111111111111111111111/rollout-authority'
) as ContextGraphIdV1;
export const RFC64_ROLLOUT_KAV10 = (
  '0x4444444444444444444444444444444444444444'
) as EvmAddressV1;
export const RFC64_ROLLOUT_DEPLOYMENT = Object.freeze({
  networkId: RFC64_ROLLOUT_NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: RFC64_ROLLOUT_KAV10,
}) as CatalogSealDeploymentProfileV1;

export function rfc64RolloutPolicyEnvelope() {
  return unsignedOpenContextGraphPolicyEnvelopeV1(buildOpenOwnerContextGraphPolicyV1({
    networkId: RFC64_ROLLOUT_NETWORK_ID,
    contextGraphId: RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    ownerAddress: RFC64_ROLLOUT_AUTHOR,
  }));
}

export function rfc64RolloutActivation(
  mode: 'legacy' | 'shadow' | 'catalog',
  killSwitch = false,
): Rfc64PublicCatalogActivationInputV1 {
  return {
    deploymentProfile: RFC64_ROLLOUT_DEPLOYMENT,
    rollout: {
      killSwitch,
      contextGraphModes: { [RFC64_ROLLOUT_CONTEXT_GRAPH_ID]: mode },
    },
    bootstrap: {
      acceptedPublicPolicies: [{ policyEnvelope: rfc64RolloutPolicyEnvelope(), targets: [] }],
      retryIntervalMs: 1_000,
    },
  };
}

export interface Rfc64RolloutStartAgentOptions {
  readonly name: string;
  readonly activation?: Rfc64PublicCatalogActivationInputV1;
  readonly dataDir?: string;
  readonly persistentStorePath?: string;
  readonly beforeStart?: (agent: DKGAgent) => void | Promise<void>;
  readonly config?: Partial<Parameters<typeof DKGAgent.create>[0]>;
}

export function createRfc64RolloutAgentHarness() {
  const agents = new Set<DKGAgent>();
  const tempDirs = new Set<string>();

  const createDataDir = async (label: string): Promise<string> => {
    const dataDir = await mkdtemp(join(tmpdir(), `dkg-rfc64-${label}-`));
    tempDirs.add(dataDir);
    return dataDir;
  };

  const startAgent = async (options: Rfc64RolloutStartAgentOptions): Promise<DKGAgent> => {
    const {
      name,
      activation: activationInput,
      persistentStorePath,
      beforeStart,
      config = {},
    } = options;
    const dataDir = options.dataDir ?? await createDataDir(name);
    const agent = await DKGAgent.create({
      name,
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      nodeRole: 'edge',
      store: new OxigraphStore(persistentStorePath),
      syncSharedMemoryOnConnect: false,
      syncReconcilerEnabled: false,
      syncOnConnectEnabled: false,
      durableSyncEnabled: false,
      agentProfileHeartbeatMs: 0,
      syncContextGraphs: activationInput?.bootstrap?.acceptedPublicPolicies.map(
        ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId,
      ) ?? [],
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: RFC64_ROLLOUT_NETWORK_ID,
      },
      rfc64PublicCatalogActivation: activationInput,
      ...config,
    });
    agents.add(agent);
    await beforeStart?.(agent);
    await agent.start();
    for (const contextGraphId of config.syncContextGraphs
      ?? activationInput?.bootstrap?.acceptedPublicPolicies.map(
        ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId,
      )
      ?? []) {
      agent.subscribeToContextGraph(contextGraphId);
    }
    return agent;
  };

  const stopAgent = async (agent: DKGAgent): Promise<void> => {
    await agent.stop();
    agents.delete(agent);
  };

  const restartAgent = async (
    previous: DKGAgent,
    options: Rfc64RolloutStartAgentOptions,
  ): Promise<DKGAgent> => {
    await stopAgent(previous);
    return startAgent(options);
  };

  const cleanup = async (): Promise<void> => {
    for (const agent of agents) {
      try { await agent.stop(); } catch { /* best effort */ }
    }
    agents.clear();
    await Promise.all([...tempDirs].map(
      (path) => rm(path, { recursive: true, force: true }),
    ));
    tempDirs.clear();
  };

  return { createDataDir, startAgent, stopAgent, restartAgent, cleanup };
}
