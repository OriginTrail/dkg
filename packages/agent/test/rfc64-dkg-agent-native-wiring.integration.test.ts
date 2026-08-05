import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MemoryLayer,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  computeContextGraphPolicyObjectDigestV1,
  computeNetworkId,
  contextGraphLayerUri,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type AssertionSeal,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type NetworkIdV1,
  type TimestampMsV1,
  type UnsignedContextGraphPolicyEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/dkg-agent.js';
import {
  snapshotRfc64CatalogAccessPolicyAuthorityV1,
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from '../src/dkg-agent-rfc64-catalog.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import {
  resolveRfc64PublicCatalogActivationChainIdentityV1,
  resolveRfc64PublicCatalogActivationConfigV1,
  resolveRfc64PublicCatalogControlsV1,
  type Rfc64PublicCatalogActivationInputV1,
} from '../src/rfc64/public-catalog-activation-config-v1.js';
import type {
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
  Rfc64CatalogAccessPolicyAuthorityConfigV1,
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from '../src/dkg-agent-types.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
} from '../../chain/test/loopback-rpc-harness.js';
import {
  FinalizedVmLoopbackMockChainAdapterV1,
  createFinalizedVmLoopbackRpcV1,
  type FinalizedVmLoopbackFixtureConfigV1,
} from './support/rfc64-finalized-vm-loopback-fixture.js';
import { RFC64_M0_RECOVERY_SCENARIO_MANIFEST } from '../scripts/rfc64-m0-recovery-manifest.mjs';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-wiring' as ContextGraphIdV1;
const FIXED_HEAD_ISSUED_AT = '1773900000000' as TimestampMsV1;
const DELEGATION_EFFECTIVE_AT = '1773899999999' as TimestampMsV1;
const DELEGATION_EXPIRES_AT = '1773900000001' as TimestampMsV1;
const MULTI_DELEGATION_EXPIRES_AT = '1774000000000' as TimestampMsV1;
const SUCCESSOR_ISSUED_AT = '1773900001000' as TimestampMsV1;
const SECOND_SUCCESSOR_ISSUED_AT = '1773900002000' as TimestampMsV1;
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const KA_STORAGE = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const CONTEXT_GRAPH_STORAGE =
  '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const ON_CHAIN_CONTEXT_GRAPH_ID = '14';
const FINALIZED_BLOCK_HASH = `0x${'77'.repeat(32)}` as Digest32V1;
const FINALIZED_POLICY_DIGEST = `0x${'cd'.repeat(32)}` as Digest32V1;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
const NATIVE_DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];
const rpcHarness = createLoopbackJsonRpcTestHarness();
const RFC64_M0_RECOVERY_SCENARIOS = Object.freeze(
  RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map(({ id }) => id),
);
const rfc64M0RecoveryScenarioById = new Map(
  RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map((scenario) => [scenario.id, scenario]),
);
type Rfc64M0RecoveryScenario = string;
interface Rfc64M0RecoveryScenarioSpec {
  readonly title: string;
  readonly handler: () => void | Promise<void>;
  readonly timeout?: number;
}
const activeRfc64M0RecoveryScenario = process.env.DKG_RFC64_M0_RECOVERY_SCENARIO;
if (
  activeRfc64M0RecoveryScenario !== undefined
  && !(RFC64_M0_RECOVERY_SCENARIOS as readonly string[])
    .includes(activeRfc64M0RecoveryScenario)
) {
  throw new Error(
    `Unknown DKG_RFC64_M0_RECOVERY_SCENARIO: ${activeRfc64M0RecoveryScenario}`,
  );
}
const registeredRfc64M0RecoveryScenarios = new Map<
  Rfc64M0RecoveryScenario,
  Rfc64M0RecoveryScenarioSpec
>();
const ordinaryNativeWiringDescribe = describe.skipIf(
  activeRfc64M0RecoveryScenario !== undefined,
);

function registerM0RecoveryScenario(
  scenario: Rfc64M0RecoveryScenario,
  title: string,
  handler: () => void | Promise<void>,
  timeout?: number,
): void {
  if (registeredRfc64M0RecoveryScenarios.has(scenario)) {
    throw new Error(`Duplicate RFC-64 M0 recovery scenario registration: ${scenario}`);
  }
  registeredRfc64M0RecoveryScenarios.set(scenario, { title, handler, timeout });
}

function rfc64M0RecoveryTitle(scenario: Rfc64M0RecoveryScenario): string {
  const metadata = rfc64M0RecoveryScenarioById.get(scenario);
  if (metadata === undefined) {
    throw new Error(`Missing RFC-64 M0 recovery scenario metadata: ${scenario}`);
  }
  return metadata.title;
}

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best-effort */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  await rpcHarness.stopAll();
});

async function startNativeAgent(
  name: string,
  deployment: CatalogSealDeploymentProfileV1 = NATIVE_DEPLOYMENT,
  existingDataDir?: string,
  accessPolicyAuthority?: Rfc64CatalogAccessPolicyAuthorityConfigV1,
  finalizedRuntime?: Readonly<{
    rpcUrl: string;
    chainAdapter: FinalizedVmLoopbackMockChainAdapterV1;
    initialSubscription?: ContextGraphIdV1;
  }>,
  autoPublish?: Rfc64PublicCatalogAutoPublishConfigV1,
): Promise<DKGAgent> {
  return startNativeAgentWithOptions({
    name,
    deployment,
    existingDataDir,
    accessPolicyAuthority,
    finalizedRuntime,
    autoPublish,
  });
}

interface NativeAgentStartOptionsV1 {
  readonly name: string;
  readonly deployment?: CatalogSealDeploymentProfileV1;
  readonly existingDataDir?: string;
  readonly accessPolicyAuthority?: Rfc64CatalogAccessPolicyAuthorityConfigV1;
  readonly finalizedRuntime?: Readonly<{
    rpcUrl: string;
    chainAdapter: FinalizedVmLoopbackMockChainAdapterV1;
    initialSubscription?: ContextGraphIdV1;
  }>;
  readonly autoPublish?: Rfc64PublicCatalogAutoPublishConfigV1;
  readonly bootstrap?: Rfc64PublicCatalogBootstrapConfigV1;
  readonly activation?: Rfc64PublicCatalogActivationInputV1;
  readonly persistentStorePath?: string;
  readonly networkIdentityChainId?: NetworkIdV1;
}

async function startNativeAgentWithOptions(
  options: NativeAgentStartOptionsV1,
): Promise<DKGAgent> {
  const {
    name,
    deployment = NATIVE_DEPLOYMENT,
    existingDataDir,
    accessPolicyAuthority,
    finalizedRuntime,
    autoPublish,
    bootstrap,
    activation,
    persistentStorePath,
    networkIdentityChainId = activation === undefined ? undefined : deployment.networkId,
  } = options;
  const dataDir = existingDataDir
    ?? await mkdtemp(join(tmpdir(), `dkg-rfc64-native-${name}-`));
  if (existingDataDir === undefined) tempDirs.push(dataDir);
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
    rfc64CatalogAccessPolicyAuthority: accessPolicyAuthority,
    ...(networkIdentityChainId === undefined ? {} : {
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: networkIdentityChainId,
      },
    }),
    ...(activation === undefined ? {
      rfc64CatalogDeploymentProfile: deployment,
      rfc64PublicCatalogAutoPublish: autoPublish,
      rfc64PublicCatalogBootstrap: bootstrap,
    } : {
      rfc64PublicCatalogActivation: activation,
    }),
    ...(finalizedRuntime === undefined ? {} : {
      chainAdapter: finalizedRuntime.chainAdapter,
      chainConfig: {
        rpcUrl: finalizedRuntime.rpcUrl,
        hubAddress: CONTEXT_GRAPH_STORAGE,
        operationalKeys: [`0x${'12'.repeat(32)}`],
      },
      ...(finalizedRuntime.initialSubscription === undefined ? {} : {
        contextGraphSubscriptionStore: seededSubscriptionStore(
          finalizedRuntime.initialSubscription,
        ),
      }),
    }),
  });
  agents.push(agent);
  await agent.start();
  return agent;
}
function seededSubscriptionStore(contextGraphId: string): ContextGraphSubscriptionStore {
  const records = new Map<string, ContextGraphSubscriptionRecord>([[contextGraphId, {
    id: contextGraphId,
    subscribed: true,
    synced: false,
    syncScoped: true,
  }]]);
  return {
    loadAll: async () => [...records.values()].map((record) => ({ ...record })),
    load: async (id) => {
      const record = records.get(id);
      return record === undefined ? null : { ...record };
    },
    save: async (record) => { records.set(record.id, { ...record }); },
    delete: async (id) => { records.delete(id); },
  };
}

function tcpMultiaddr(agent: DKGAgent): string {
  const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return address;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  await a.node.libp2p.dial(multiaddr(tcpMultiaddr(b)));
  await b.node.libp2p.dial(multiaddr(tcpMultiaddr(a)));
}

function catalogScopeDigest() {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    era: '0' as never,
    bucketCount: '1' as never,
  });
}

function privateCatalogPolicy(): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '7',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 1,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'owner-signed-unregistered',
      ownerAddress: AUTHOR,
      ownerAuthorityEra: '0',
    },
    effectiveAt: '0',
    issuedAt: '0',
  };
}

function finalizedPublicCatalogPolicy(options: Readonly<{
  publishPolicy: ContextGraphPolicyV1['publishPolicy'];
  publishAuthority: EvmAddressV1 | null;
}> = { publishPolicy: 1, publishAuthority: null }): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: CONTEXT_GRAPH_STORAGE,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: options.publishPolicy,
    publishAuthority: options.publishAuthority,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'finalized-chain',
      chainId: '20430',
      contractAddress: CONTEXT_GRAPH_STORAGE,
      blockNumber: '120',
      blockHash: `0x${'76'.repeat(32)}`,
    },
    effectiveAt: '1773900000000',
    issuedAt: '1773900000000',
  };
}

function privateCatalogRoster(
  policy: ContextGraphPolicyV1,
  policyDigest: Digest32V1,
): MemberRosterV1 {
  return {
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    era: policy.era,
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: policy.administrativeDelegationDigest,
    members: [{ agentAddress: AUTHOR, roles: ['holder', 'provider'] }],
    issuedAt: '0',
  };
}

ordinaryNativeWiringDescribe('RFC-64 DKGAgent production native catalog wiring', () => {
  it('preserves the EVM default chain identity for a no-admin chain config', async () => {
    const operational = ethers.Wallet.createRandom();
    const agent = await DKGAgent.create({
      name: 'rfc64-no-admin-default-chain',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:0',
        hubAddress: ethers.ZeroAddress,
        operationalKeys: [operational.privateKey],
      },
      nodeRole: 'core',
    });
    agents.push(agent);

    expect(agent).toBeInstanceOf(DKGAgent);
  });

  it('snapshots and canonicalizes the deterministic local deployment override', () => {
    const callerOwned = {
      networkId: NETWORK_ID,
      assertedAtChainId: '20430',
      assertedAtKav10Address: ethers.getAddress(
        '0x4444444444444444444444444444444444444444',
      ),
    } as CatalogSealDeploymentProfileV1;
    const snapshot = snapshotRfc64CatalogDeploymentProfileV1(callerOwned)!;
    (callerOwned as { networkId: NetworkIdV1 }).networkId = 'hostile:1' as NetworkIdV1;
    expect(snapshot).toEqual(NATIVE_DEPLOYMENT);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshotRfc64CatalogDeploymentProfileV1({
      ...NATIVE_DEPLOYMENT,
      assertedAtKav10Address: `0x${'00'.repeat(20)}` as never,
    })).toThrow(/non-zero EVM address/);
  });

  it('snapshots the opt-in normal-publication catalog producer configuration', () => {
    const callerOwned = {
      peers: ['12D3KooReceiver'],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const snapshot = snapshotRfc64PublicCatalogAutoPublishConfigV1(callerOwned)!;
    callerOwned.peers.push('hostile-late-mutation');
    expect(snapshot).toEqual({
      peers: ['12D3KooReceiver'],
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.peers)).toBe(true);
    expect(() => snapshotRfc64PublicCatalogAutoPublishConfigV1({
      peers: ['duplicate', 'duplicate'],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    })).toThrow(/duplicated/u);
  });

  it('keeps direct legacy agent auto-publish configuration source-compatible', async () => {
    const agent = await startNativeAgent(
      'legacy-direct-agent-config',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    expect(agent).toBeInstanceOf(DKGAgent);
  });

  it('normalizes legacy and selected auto-publish into one internal policy', () => {
    const chainIdentity = resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID);
    const selectedPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      autoPublish: {
        peers: ['12D3KooSelected'],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(selectedPolicy),
          targets: [],
        }],
      },
    }, chainIdentity);

    expect(resolveRfc64PublicCatalogControlsV1({ activation }, chainIdentity))
      .toMatchObject({
        autoPublishPolicy: {
          mode: 'selected-public',
          selectedContextGraphs: [CONTEXT_GRAPH_ID],
          config: { peers: ['12D3KooSelected'] },
        },
        requiresDataDir: true,
      });
    expect(resolveRfc64PublicCatalogControlsV1({
      legacyAutoPublish: {
        peers: ['12D3KooLegacy'],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(undefined)))
      .toMatchObject({
        autoPublishPolicy: {
          mode: 'all-accepted-public',
          config: { peers: ['12D3KooLegacy'] },
        },
        requiresDataDir: false,
      });
  });

  it('rejects a direct resolved activation whose selection differs from its manifest', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      deploymentProfile: NATIVE_DEPLOYMENT,
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
        }],
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID));

    await expect(DKGAgent.create({
      name: 'split-selected-agent-config',
      networkIdentity: { networkId: 'rfc64-test', chainId: NETWORK_ID },
      rfc64PublicCatalogActivation: {
        ...activation,
        selectedContextGraphs: ['different-selection'],
      } as never,
    })).rejects.toThrow(/selected graphs differ from the bootstrap manifest/u);
  });

  it('projects raw selected activation into direct agent durable sync scope', async () => {
    const selectedPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const agent = await startNativeAgentWithOptions({
      name: 'direct-selected-sync-scope',
      activation: {
        enabled: true,
        deploymentProfile: NATIVE_DEPLOYMENT,
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(selectedPolicy),
            targets: [],
          }],
        },
      },
    });

    expect((agent as any).config.syncContextGraphs).toContain(CONTEXT_GRAPH_ID);
  });

  it('keeps direct disabled activation fail-closed even when stale controls are present', async () => {
    const ignoredPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const agent = await startNativeAgentWithOptions({
      name: 'direct-disabled-stale-controls',
      activation: {
        enabled: false,
        deploymentProfile: NATIVE_DEPLOYMENT,
        autoPublish: {
          peers: ['12D3KooIgnored'],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(ignoredPolicy),
            targets: [],
          }],
        },
      },
    });

    expect((agent as any).config.syncContextGraphs).not.toContain(CONTEXT_GRAPH_ID);
    expect((agent as any).config.rfc64PublicCatalogBootstrap).toBeUndefined();
    expect((agent as any).config.rfc64PublicCatalogAutoPublishPolicy).toBeUndefined();
  });

  it('snapshots a bounded public-root bootstrap manifest', () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const policyEnvelope = unsignedOpenContextGraphPolicyEnvelopeV1(policy);
    const providers = ['12D3KooPrimary'];
    const callerOwned: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope,
        targets: [{ authorAddress: AUTHOR, providers }],
      }],
      retryIntervalMs: 1_000,
    };
    const snapshot = snapshotRfc64PublicCatalogBootstrapConfigV1(callerOwned)!;
    providers.push('12D3KooLateMutation');

    expect(snapshot.acceptedPublicPolicies[0]?.targets[0]?.providers)
      .toEqual(['12D3KooPrimary']);
    expect(snapshot.acceptedPublicPolicies[0]?.policyEnvelope.payload).toEqual(policy);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.acceptedPublicPolicies[0]?.targets)).toBe(true);
    expect(Object.isFrozen(snapshot.acceptedPublicPolicies[0]?.targets[0]?.providers)).toBe(true);
    expect(Object.isFrozen(snapshot.acceptedPublicPolicies[0]?.policyEnvelope.payload.source))
      .toBe(true);
    expect(() => snapshotRfc64PublicCatalogBootstrapConfigV1({
      acceptedPublicPolicies: [{
        ...callerOwned.acceptedPublicPolicies[0]!,
        policyDigest: `0x${'11'.repeat(32)}`,
      }],
    } as unknown as Rfc64PublicCatalogBootstrapConfigV1)).toThrow(/unknown or missing fields/u);
  });

  it('rejects bootstrap without persistence before node startup', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await expect(DKGAgent.create({
      name: 'ephemeral-bootstrap-is-invalid',
      rfc64PublicCatalogBootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [{ authorAddress: AUTHOR, providers: ['12D3KooProvider'] }],
        }],
      },
    })).rejects.toThrow(/rfc64PublicCatalogBootstrap requires dataDir/u);
  });

  it('rejects selected activation bootstrap without persistence before node startup', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
        }],
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID));
    await expect(DKGAgent.create({
      name: 'ephemeral-selected-activation-is-invalid',
      networkIdentity: { networkId: 'rfc64-test', chainId: NETWORK_ID },
      rfc64PublicCatalogActivation: activation,
    })).rejects.toThrow(/rfc64PublicCatalogBootstrap requires dataDir/u);
  });

  it('rejects selected activation mixed with a legacy catalog control', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
        }],
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID));
    await expect(DKGAgent.create({
      name: 'mixed-selected-and-legacy-controls',
      networkIdentity: { networkId: 'rfc64-test', chainId: NETWORK_ID },
      rfc64PublicCatalogActivation: activation,
      rfc64PublicCatalogAutoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    })).rejects.toThrow(/mutually exclusive/u);
  });

  it('does not let an activation deployment profile supply its own chain identity', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const activation = resolveRfc64PublicCatalogActivationConfigV1({
      enabled: true,
      deploymentProfile: NATIVE_DEPLOYMENT,
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [],
        }],
      },
    }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID));
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-self-bound-chain-'));
    tempDirs.push(dataDir);
    await expect(DKGAgent.create({
      name: 'self-bound-deployment-is-invalid',
      dataDir,
      rfc64PublicCatalogActivation: activation,
    })).rejects.toThrow(/requires an effective network id/u);
  });

  it('turns one confirmed public KA into the provider current head and one cold receiver apply', async () => {
    const acceptedButUnselectedContextGraphId = (
      '0x1111111111111111111111111111111111111111/accepted-not-selected'
    ) as ContextGraphIdV1;
    const receiver = await startNativeAgentWithOptions({
      name: 'auto-publish-receiver',
      networkIdentityChainId: NETWORK_ID,
    });
    const selectedPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const author = await startNativeAgentWithOptions({
      name: 'auto-publish-author',
      activation: resolveRfc64PublicCatalogActivationConfigV1({
        enabled: true,
        deploymentProfile: NATIVE_DEPLOYMENT,
        autoPublish: {
          peers: [receiver.peerId],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(selectedPolicy),
            targets: [],
          }],
        },
      }, resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK_ID)),
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    for (const agent of [author, receiver]) {
      agent.acceptOpenContextGraphPolicyV1({
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        ownerAddress: AUTHOR,
      });
    }
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: acceptedButUnselectedContextGraphId,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, receiver);

    const seal = assertionSealFromCanonical(await authorSeal(11n));
    const ignored = await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: acceptedButUnselectedContextGraphId,
      assertionCoordinate: 'ordinary-confirmed-publication-other-cg' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal,
    });
    expect(ignored).toBeNull();
    const acceptedButUnselectedScopeDigest = computeAuthorCatalogScopeDigestV1({
      networkId: NETWORK_ID,
      contextGraphId: acceptedButUnselectedContextGraphId,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0' as never,
      bucketCount: '1' as never,
    });
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: acceptedButUnselectedScopeDigest,
      authorAddress: AUTHOR,
    })).toBeNull();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: acceptedButUnselectedScopeDigest,
      authorAddress: AUTHOR,
    })).toBeNull();

    const first = await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'ordinary-confirmed-publication' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: 'urn:ignored-local-graph',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: 'urn:ignored-local-graph',
        },
      ],
      seal,
    });
    expect(first).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const scopeDigest = catalogScopeDigest();
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toEqual(first);
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: first?.currentCatalogHeadDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      failed: 0,
    });

    const replay = await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'ordinary-confirmed-publication' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal,
    });
    expect(replay).toEqual(first);
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver.applied).toBe(1);

    const second = await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'second-ordinary-confirmed-publication' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal: assertionSealFromCanonical(await authorSeal(12n)),
    });
    expect(second).toMatchObject({ catalogVersion: '2', inventoryRowCount: '2' });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: second?.currentCatalogHeadDigest,
      catalogVersion: '2',
      inventoryRowCount: '2',
    });
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 2,
      failed: 0,
    });
  }, 60_000);

  it('canonicalizes ordinary literal lexical forms before catalog projection verification', async () => {
    const author = await startNativeAgent(
      'auto-publish-canonical-literal',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads = [{
      subject: 'https://example.org/alice',
      predicate: 'https://schema.org/age',
      object: '"042"^^<http://www.w3.org/2001/XMLSchema#integer>',
      graph: 'urn:ignored-local-graph',
    }];

    await expect(author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'ordinary-noncanonical-literal' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(13n, publicQuads)),
    })).resolves.toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
  }, 60_000);

  it('uses the chain signer for a confirmed author when no custodial key is available', async () => {
    const author = await startNativeAgent(
      'auto-publish-chain-signer',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(undefined);
    const chain = (author as unknown as {
      chain: {
        signMessageAs?: (
          address: string,
          message: Uint8Array,
        ) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
      };
    }).chain;
    const signMessageAs = vi.fn(async (address: string, message: Uint8Array) => {
      expect(address).toBe(AUTHOR);
      const signature = ethers.Signature.from(await AUTHOR_WALLET.signMessage(message));
      return {
        r: ethers.getBytes(signature.r),
        vs: ethers.getBytes(signature.yParityAndS),
      };
    });
    chain.signMessageAs = signMessageAs;
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });

    await expect(author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'ordinary-chain-signed-publication' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal: assertionSealFromCanonical(await authorSeal(14n)),
    })).resolves.toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    expect(signMessageAs).toHaveBeenCalled();
  }, 60_000);

  it('does not expose an empty applied head when first-asset successor staging fails', async () => {
    const author = await startNativeAgent(
      'auto-publish-first-asset-retry',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
    ];
    const params = {
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'first-asset-retry' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(60n, publicQuads)),
    };
    const publishSuccessor = vi.spyOn(author, 'publishAuthorCatalogExactSetSuccessorV1')
      .mockRejectedValueOnce(new Error('simulated successor staging failure'));
    await expect(author.recordConfirmedRfc64PublicCatalogAssetV1(params))
      .rejects.toThrow('simulated successor staging failure');
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();

    publishSuccessor.mockRestore();
    await expect(author.recordConfirmedRfc64PublicCatalogAssetV1(params)).resolves.toMatchObject({
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
  }, 60_000);

  it('atomically serializes concurrent first-asset catalog upserts without losing a row', async () => {
    const receiver = await startNativeAgent('auto-publish-concurrent-receiver');
    const author = await startNativeAgent(
      'auto-publish-concurrent-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [receiver.peerId],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    for (const agent of [author, receiver]) {
      agent.acceptOpenContextGraphPolicyV1({
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        ownerAddress: AUTHOR,
      });
    }
    await connectBothWays(author, receiver);

    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
    ];
    const kaNumbers = [61n, 62n] as const;
    const results = await Promise.all(kaNumbers.map(async (kaNumber, index) => (
      author.recordConfirmedRfc64PublicCatalogAssetV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        assertionCoordinate: `concurrent-confirmed-${index + 1}` as never,
        publicQuads,
        seal: assertionSealFromCanonical(await authorSeal(kaNumber, publicQuads)),
      })
    )));
    expect(results).not.toContain(null);
    const first = results.find((result) => result?.catalogVersion === '1');
    const final = results.find((result) => result?.catalogVersion === '2');
    expect(final).toMatchObject({ catalogVersion: '2', inventoryRowCount: '2' });
    if (first === undefined || first === null || final === undefined || final === null) {
      throw new Error('concurrent catalog upserts did not produce both successors');
    }

    const scopeDigest = catalogScopeDigest();
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR,
    })).toEqual(final);
    await vi.waitFor(() => {
      expect(receiver.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: scopeDigest,
        authorAddress: AUTHOR,
      })?.currentCatalogHeadDigest).toBe(final.currentCatalogHeadDigest);
    }, { timeout: 20_000, interval: 100 });
    const evidence = receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      final.currentCatalogHeadDigest,
    );
    expect(evidence).toMatchObject({
      inventoryRowCount: 2,
      appliedHeadStatus: 'applied',
    });
    expect(new Set(evidence?.rows.map(({ kaId }) => kaId))).toEqual(new Set(
      kaNumbers.map((kaNumber) => ((BigInt(AUTHOR) << 96n) | kaNumber).toString()),
    ));
  }, 60_000);

  registerM0RecoveryScenario('cold-restart', rfc64M0RecoveryTitle('cold-restart'), async () => {
    const author = await startNativeAgent(
      'bootstrap-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const accepted = author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
    ] as const;
    await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'bootstrap-publication-1' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(21n)),
    });
    const published = await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'bootstrap-publication-2' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(22n)),
    });
    expect(published).toMatchObject({ catalogVersion: '2', inventoryRowCount: '2' });

    const bootstrap: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(accepted.policy),
        targets: [{ authorAddress: AUTHOR, providers: [author.peerId] }],
      }],
      retryIntervalMs: 1_000,
    };
    const receiverDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-native-bootstrap-'));
    tempDirs.push(receiverDataDir);
    const persistentStorePath = join(receiverDataDir, 'oxigraph');
    const receiver = await startNativeAgentWithOptions({
      name: 'bootstrap-receiver',
      existingDataDir: receiverDataDir,
      bootstrap,
      persistentStorePath,
    });
    await connectBothWays(author, receiver);
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        providerPeerId: author.peerId,
        appliedHeadDigest: published?.currentCatalogHeadDigest,
        catalogVersion: '2',
        inventoryRowCount: '2',
      });
    }, { timeout: 20_000, interval: 100 });
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: published?.currentCatalogHeadDigest,
      catalogVersion: '2',
      inventoryRowCount: '2',
    });

    await receiver.stop();
    agents.splice(agents.indexOf(receiver), 1);
    const restarted = await startNativeAgentWithOptions({
      name: 'bootstrap-receiver',
      existingDataDir: receiverDataDir,
      bootstrap,
      persistentStorePath,
    });
    await connectBothWays(author, restarted);
    await vi.waitFor(() => {
      expect(restarted.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        providerPeerId: author.peerId,
        appliedHeadDigest: published?.currentCatalogHeadDigest,
        catalogVersion: '2',
        inventoryRowCount: '2',
      });
    }, { timeout: 20_000, interval: 100 });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: published?.currentCatalogHeadDigest,
      catalogVersion: '2',
      inventoryRowCount: '2',
    });
  }, 60_000);

  registerM0RecoveryScenario('provider-failover', rfc64M0RecoveryTitle('provider-failover'), async () => {
    const emptyProvider = await startNativeAgent('bootstrap-empty-provider');
    const author = await startNativeAgent(
      'bootstrap-retry-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const accepted = author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    emptyProvider.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const bootstrap: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(accepted.policy),
        targets: [{
          authorAddress: AUTHOR,
          providers: [emptyProvider.peerId, author.peerId],
        }],
      }],
      retryIntervalMs: 1_000,
    };
    const receiver = await startNativeAgentWithOptions({
      name: 'bootstrap-retry-receiver',
      bootstrap,
    });
    await Promise.all([
      connectBothWays(emptyProvider, receiver),
      connectBothWays(author, receiver),
    ]);
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'not-found',
        attempts: 2,
        providerPeerId: null,
        appliedHeadDigest: null,
      });
    }, { timeout: 20_000, interval: 100 });

    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
    ];
    const published = await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'bootstrap-retry-publication' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(23n, publicQuads)),
    });
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
        pass: expect.any(Number),
        targets: [expect.objectContaining({
          outcome: 'applied',
          attempts: 2,
          providerPeerId: author.peerId,
          appliedHeadDigest: published?.currentCatalogHeadDigest,
          inventoryRowCount: '1',
        })],
      });
    }, { timeout: 20_000, interval: 100 });
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })?.currentCatalogHeadDigest).toBe(published?.currentCatalogHeadDigest);
  }, 60_000);

  it('clears applied metadata when a later bootstrap refresh misses', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const appliedHeadDigest = `0x${'a1'.repeat(32)}` as Digest32V1;
    const synchronize = vi.spyOn(
      DKGAgent.prototype,
      'synchronizeRfc64PublicCatalogFromProviderV1',
    ).mockResolvedValueOnce({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
      currentCatalogHeadDigest: appliedHeadDigest,
      appliedInventoryDigest: `0x${'b2'.repeat(32)}` as Digest32V1,
      catalogVersion: '2' as never,
      inventoryRowCount: '3' as never,
    }).mockResolvedValue(null);
    const bootstrap: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
        targets: [{ authorAddress: AUTHOR, providers: ['12D3KooStatusProvider'] }],
      }],
      retryIntervalMs: 1_000,
    };
    const receiver = await startNativeAgentWithOptions({
      name: 'bootstrap-status-reset',
      bootstrap,
    });
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        appliedHeadDigest,
        catalogVersion: '2',
        inventoryRowCount: '3',
      });
    }, { timeout: 10_000, interval: 50 });
    await vi.waitFor(() => {
      expect(receiver.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'not-found',
        attempts: 1,
        providerPeerId: null,
        appliedHeadDigest: null,
        catalogVersion: null,
        inventoryRowCount: null,
      });
    }, { timeout: 10_000, interval: 50 });
    expect(synchronize).toHaveBeenCalledTimes(2);
    synchronize.mockRestore();
  }, 30_000);


  it('serializes mixed-case projection terms in raw UTF-8 order', async () => {
    const author = await startNativeAgent(
      'auto-publish-byte-order',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const publicQuads = [
      {
        subject: 'urn:a',
        predicate: 'https://schema.org/name',
        object: '"lowercase"',
        graph: '',
      },
      {
        subject: 'urn:Z',
        predicate: 'https://schema.org/name',
        object: '"uppercase"',
        graph: '',
      },
    ];
    const applied = await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'mixed-case-byte-order' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(31n, publicQuads)),
    });
    expect(applied).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
  }, 60_000);

  it('explicitly skips private-bearing ordinary publishes in the public-only V1 bridge', async () => {
    const author = await startNativeAgent(
      'auto-publish-private-skip',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      undefined,
      {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const privateBearingSeal: AssertionSeal = {
      ...assertionSealFromCanonical(await authorSeal(32n)),
      privateTripleCount: 1,
      privateMerkleRoot: ethers.getBytes(`0x${'99'.repeat(32)}`),
    };
    await expect(author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'private-bearing-skip' as never,
      publicQuads: [
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/name',
          object: '"Alice"',
          graph: '',
        },
        {
          subject: 'https://example.org/alice',
          predicate: 'https://schema.org/age',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: '',
        },
      ],
      seal: privateBearingSeal,
    })).resolves.toBeNull();
    expect(author.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 60_000);


  it('snapshots the explicit access authority and fails closed before private activation', async () => {
    const resolver = async () => AUTHOR;
    const callerOwned = {
      localAgentAddress: ethers.getAddress(AUTHOR) as EvmAddressV1,
      resolveRemoteAgentAddress: resolver,
    };
    const snapshot = snapshotRfc64CatalogAccessPolicyAuthorityV1(callerOwned)!;
    callerOwned.localAgentAddress = ethers.ZeroAddress as EvmAddressV1;
    expect(snapshot).toEqual({
      localAgentAddress: AUTHOR,
      resolveRemoteAgentAddress: resolver,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshotRfc64CatalogAccessPolicyAuthorityV1({
      localAgentAddress: ethers.ZeroAddress as EvmAddressV1,
      resolveRemoteAgentAddress: resolver,
    })).toThrow(/localAgentAddress is invalid/);

    const policy = privateCatalogPolicy();
    const policyDigest = `0x${'ab'.repeat(32)}` as Digest32V1;
    const roster = privateCatalogRoster(policy, policyDigest);
    const legacyOpenOnly = await startNativeAgent('private-denied');
    expect(() => legacyOpenOnly.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster,
    })).toThrow(/requires explicit access-policy authority/);

    const configured = await startNativeAgent(
      'private-configured',
      NATIVE_DEPLOYMENT,
      undefined,
      {
        localAgentAddress: AUTHOR,
        resolveRemoteAgentAddress: resolver,
      },
    );
    expect(configured.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster,
    })).toMatchObject({ policyDigest, roster: { policyDigest } });

    const privateGenesis = {
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: 'service-lane',
        authorAddress: AUTHOR,
        era: '0',
        bucketCount: '1',
      },
      author: AUTHOR_WALLET,
      peers: [],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    } as const;
    await expect(configured.publishAuthorCatalogGenesisV1({
      ...privateGenesis,
      peers: ['12D3KooPrivateReceiver'],
    })).rejects.toThrow(/private catalog peer fan-out requires scope-bound/u);
    const published = await configured.publishAuthorCatalogGenesisV1(privateGenesis);
    expect(published.announcement).toMatchObject({
      policyDigest,
      subGraphName: 'service-lane',
      catalogEra: '0',
    });

    const privateSuccessor = {
      previousHead: {
        objectDigest: published.headObjectDigest,
        signatureVariantDigest: published.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: published.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: 'private-subgraph-object' as never,
        projectionBytes: PROJECTION,
        seal: await authorSeal(7n),
      }],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [],
    } as const;
    await expect(configured.publishOpenAuthorCatalogExactSetSuccessorV1(privateSuccessor))
      .rejects.toThrow(/public\/open compatibility successor requires the root lane/u);
    await expect(configured.publishAuthorCatalogExactSetSuccessorV1({
      ...privateSuccessor,
      peers: ['12D3KooPrivateReceiver'],
    })).rejects.toThrow(/private catalog peer fan-out requires scope-bound/u);
    const successor = await configured.publishAuthorCatalogExactSetSuccessorV1(privateSuccessor);
    expect(successor).toMatchObject({
      announcement: {
        policyDigest,
        subGraphName: 'service-lane',
        catalogEra: '0',
      },
      catalogScope: {
        subGraphName: 'service-lane',
        era: '0',
      },
      inventoryRowCount: '1',
    });
  }, 60_000);

  it('uses the trusted override to fetch provider content and durably apply native genesis', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('author'),
      startNativeAgent('receiver'),
    ]);
    const receiverPolicy = receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, receiver);

    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    expect(published.announcement.policyDigest).toBe(receiverPolicy.policyDigest);
    expect(published.announcedPeers).toEqual([]);
    const delivery = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [receiver.peerId],
    });
    expect(delivery.announcedPeers).toEqual([receiver.peerId]);
    expect(delivery.failedPeers).toEqual([]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const scopeDigest = catalogScopeDigest();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })).toMatchObject({
      catalogScopeDigest: scopeDigest,
      currentCatalogHeadDigest: published.headObjectDigest,
      catalogVersion: '0',
      inventoryRowCount: '0',
    });
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toMatchObject({
      catalogHeadDigest: published.headObjectDigest,
      inventoryRowCount: 0,
      activatedTripleCount: 0,
      stagedObjectCount: 3,
      appliedHeadStatus: 'applied',
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      stagedOnly: 0,
      failed: 0,
    });

    const replay = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [receiver.peerId],
    });
    expect(replay.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      dedupedAlreadyApplied: 1,
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
  }, 60_000);

  it('reads the exact staged head variant to dedupe a durably applied multi-row set', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('multi-author'),
      startNativeAgent('multi-receiver'),
    ]);
    receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, receiver);

    const genesis = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const firstAsset = {
      assertionCoordinate: 'gate-2-object-1' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(7n),
    };
    const firstSuccessor = await author.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      ...firstAsset,
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [receiver.peerId],
    });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const successor = await author.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: firstSuccessor.headObjectDigest,
        signatureVariantDigest: firstSuccessor.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [
        {
          assertionCoordinate: 'gate-2-object-2' as never,
          projectionBytes: PROJECTION,
          seal: await authorSeal(8n),
        },
        firstAsset,
      ],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SECOND_SUCCESSOR_ISSUED_AT,
      peers: [receiver.peerId],
    });
    expect(successor.inventoryRowCount).toBe('2');
    expect(successor.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const evidence = receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      successor.headObjectDigest,
    );
    expect(evidence).toMatchObject({
      catalogHeadDigest: successor.headObjectDigest,
      inventoryRowCount: 2,
      appliedHeadStatus: 'applied',
    });
    expect(evidence?.rows.map(({ kaId, bundleDigest }) => ({ kaId, bundleDigest }))).toEqual(
      successor.assets.map(({ kaId, bundleDigest }) => ({ kaId, bundleDigest })),
    );
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 3,
      dedupedAlreadyApplied: 0,
    });

    const replay = await author.announceRfc64PublicCatalogHeadV1({
      announcement: successor.announcement,
      peers: [receiver.peerId],
    });
    expect(replay.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 3,
      dedupedAlreadyApplied: 1,
    });
  }, 60_000);

  it('cold-starts after publication from a provider current-head snapshot', async () => {
    const [author, provider] = await Promise.all([
      startNativeAgent('cold-author'),
      startNativeAgent('cold-provider'),
    ]);
    provider.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, provider);

    const genesis = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [provider.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();
    const successor = await author.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assertionCoordinate: 'cold-current-snapshot' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(7n),
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [provider.peerId],
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();
    expect(provider.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })?.currentCatalogHeadDigest).toBe(successor.headObjectDigest);

    // The third agent does not exist until after the successor is durable on
    // the provider, so it cannot have observed either publication hint.
    const cold = await startNativeAgent('cold-late-receiver');
    cold.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    expect(cold.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    await connectBothWays(provider, cold);

    const synchronized = await cold.synchronizeRfc64PublicCatalogFromProviderV1({
      remotePeerId: provider.peerId,
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        catalogEra: '0',
      },
    });
    expect(synchronized).toMatchObject({
      providerPeerId: provider.peerId,
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
      currentCatalogHeadDigest: successor.headObjectDigest,
      signatureVariantDigest: successor.signatureVariantDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
    expect(cold.readRfc64PublicCatalogReconciliationFailureV1(
      successor.headObjectDigest,
    )).toBeNull();
    expect(cold.readRfc64PublicCatalogSynchronizationEvidenceV1(
      successor.headObjectDigest,
    )).toMatchObject({
      catalogHeadDigest: successor.headObjectDigest,
      inventoryRowCount: 1,
      activatedTripleCount: 2,
      removedRowCount: 0,
      appliedHeadStatus: 'applied',
    });
    expect(cold.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      scheduled: 1,
      applied: 1,
      failed: 0,
    });

    const swmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.SharedWorkingMemory,
      AUTHOR,
      7,
    );
    await expect((cold as any).store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    )).resolves.toMatchObject({
      type: 'bindings',
      bindings: expect.arrayContaining([
        expect.objectContaining({ s: 'https://example.org/alice' }),
      ]),
    });
  }, 60_000);

  it('rejects the provider-sync API when scheduled semantic activation fails', async () => {
    const [author, provider] = await Promise.all([
      startNativeAgent('failure-author'),
      startNativeAgent('failure-provider'),
    ]);
    provider.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, provider);
    const genesis = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [provider.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();
    const successor = await author.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assertionCoordinate: 'failure-current-snapshot' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(7n),
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [provider.peerId],
    });
    await provider.whenRfc64PublicCatalogReceiverIdleV1();

    const cold = await startNativeAgent('failure-late-receiver');
    cold.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(provider, cold);
    const replaceGraphAndSubject = vi.spyOn(
      (cold as any).store,
      'replaceGraphAndSubject',
    ).mockRejectedValue(new Error('simulated receiver semantic-activation failure'));

    await expect(cold.synchronizeRfc64PublicCatalogFromProviderV1({
      remotePeerId: provider.peerId,
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        catalogEra: '0',
      },
    })).rejects.toThrow(/reconciliation failed \(catalog-native-receiver-activation\)/u);
    expect(replaceGraphAndSubject).toHaveBeenCalled();
    expect(cold.readRfc64PublicCatalogReconciliationFailureV1(
      successor.headObjectDigest,
    )).toEqual({
      catalogHeadDigest: successor.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-activation',
    });
    expect(cold.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 60_000);

  it('materializes finalized VM through production two-agent wiring before applying the head', async () => {
    const kaNumber = 7n;
    const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase();
    const fixture = Object.freeze({
      accessPolicy: 0,
      active: true,
      assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
      assertedAtKav10Address: KAV10,
      knowledgeAssetStorageAddress: KA_STORAGE,
      assets: Object.freeze([Object.freeze({
        assertionRoot: ASSERTION_ROOT,
        assertionVersion: '1',
        authorAddress: AUTHOR,
        kaId,
        publisherAddress: `0x${'66'.repeat(20)}` as EvmAddressV1,
      })]),
      blockHash: FINALIZED_BLOCK_HASH,
      blockNumberQuantity: '0x7b',
      contextGraphStorageAddress: CONTEXT_GRAPH_STORAGE,
      nameHash: nameHash as Digest32V1,
      networkId: NETWORK_ID,
      onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
      publishPolicy: 1,
    } satisfies FinalizedVmLoopbackFixtureConfigV1);
    const finalizedRpc = createFinalizedVmLoopbackRpcV1(fixture);
    const contextGraphInterface = new ethers.Interface([
      'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
    ]);
    expect(() => finalizedRpc.respond('eth_call', [{
      to: KAV10,
      data: contextGraphInterface.encodeFunctionData(
        'getNameHash',
        [BigInt(ON_CHAIN_CONTEXT_GRAPH_ID)],
      ),
    }, 'finalized'])).toThrow('context graph target');
    const callsBeforeRuntime = finalizedRpc.calls.length;
    const rpc = await rpcHarness.start((call, response) => {
      try {
        sendJsonRpcResult(response, call, finalizedRpc.respond(call.method, call.params));
      } catch (cause) {
        sendJsonRpcError(
          response,
          call,
          -32602,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    });
    const authorChain = new FinalizedVmLoopbackMockChainAdapterV1(fixture);
    const receiverChain = new FinalizedVmLoopbackMockChainAdapterV1(fixture);
    const created = await receiverChain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash,
    });
    expect(created.contextGraphId.toString()).toBe(ON_CHAIN_CONTEXT_GRAPH_ID);
    const [author, receiver] = await Promise.all([
      startNativeAgent(
        'vm-author',
        NATIVE_DEPLOYMENT,
        undefined,
        undefined,
        { rpcUrl: rpc.url, chainAdapter: authorChain },
      ),
      startNativeAgent(
        'vm-receiver',
        NATIVE_DEPLOYMENT,
        undefined,
        undefined,
        {
          rpcUrl: rpc.url,
          chainAdapter: receiverChain,
          initialSubscription: CONTEXT_GRAPH_ID,
        },
      ),
    ]);
    const policy = finalizedPublicCatalogPolicy();
    for (const agent of [author, receiver]) {
      agent.acceptRfc64CatalogAccessSnapshotV1({
        policy,
        policyDigest: FINALIZED_POLICY_DIGEST,
        roster: null,
      });
    }
    await receiver.awaitInitialChainPoll();
    const storeQuery = vi.spyOn((receiver as any).store, 'query');
    await expect(receiver.getContextGraphOnChainId(CONTEXT_GRAPH_ID)).resolves.toBe(
      ON_CHAIN_CONTEXT_GRAPH_ID,
    );
    await expect(receiver.getContextGraphOnChainId(nameHash)).resolves.toBe(
      ON_CHAIN_CONTEXT_GRAPH_ID,
    );
    expect(storeQuery.mock.calls.some(([query]) => String(query).includes('OnChainId'))).toBe(false);
    storeQuery.mockRestore();
    await connectBothWays(author, receiver);

    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: CONTEXT_GRAPH_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as const;
    const genesis = await author.publishAuthorCatalogGenesisV1({
      scope,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    expect(genesis.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    const successor = await author.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: 'finalized-vm-production-wire' as never,
        projectionBytes: PROJECTION,
        seal: await authorSeal(kaNumber),
      }],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [receiver.peerId],
    });
    expect(successor.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const vmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      AUTHOR,
      Number(kaNumber),
    );
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      successor.headObjectDigest,
    )).toBeNull();
    await expect((receiver as any).store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    )).resolves.toMatchObject({
      type: 'bindings',
      bindings: expect.arrayContaining([
        expect.objectContaining({ s: 'https://example.org/alice' }),
      ]),
    });
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: successor.headObjectDigest,
      inventoryRowCount: '1',
    });
    const finalizedCallTargets = finalizedRpc.calls.slice(callsBeforeRuntime)
      .filter(({ method }) => method === 'eth_call')
      .map(({ params }) => (params[0] as { readonly to?: string }).to?.toLowerCase());
    expect(finalizedCallTargets).toContain(CONTEXT_GRAPH_STORAGE);
    expect(finalizedCallTargets).toContain(KA_STORAGE);
    expect(finalizedCallTargets).not.toContain(KAV10);
  }, 60_000);

  registerM0RecoveryScenario('curated-parity', rfc64M0RecoveryTitle('curated-parity'), async () => {
    const kaNumbers = [41n] as const;
    const assets = kaNumbers.map((kaNumber) => Object.freeze({
      assertionRoot: ASSERTION_ROOT,
      assertionVersion: '1',
      authorAddress: AUTHOR,
      kaId: ((BigInt(AUTHOR) << 96n) | kaNumber).toString(),
      publisherAddress: AUTHOR,
    }));
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase();
    const fixture = Object.freeze({
      accessPolicy: 0,
      active: true,
      assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
      assertedAtKav10Address: KAV10,
      knowledgeAssetStorageAddress: KA_STORAGE,
      assets: Object.freeze(assets),
      blockHash: FINALIZED_BLOCK_HASH,
      blockNumberQuantity: '0x7c',
      contextGraphStorageAddress: CONTEXT_GRAPH_STORAGE,
      nameHash: nameHash as Digest32V1,
      networkId: NETWORK_ID,
      onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
      publishPolicy: 0,
    } satisfies FinalizedVmLoopbackFixtureConfigV1);
    const finalizedRpc = createFinalizedVmLoopbackRpcV1(fixture);
    const rpc = await rpcHarness.start((call, response) => {
      try {
        sendJsonRpcResult(response, call, finalizedRpc.respond(call.method, call.params));
      } catch (cause) {
        sendJsonRpcError(
          response,
          call,
          -32602,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    });
    const policy = finalizedPublicCatalogPolicy({
      publishPolicy: 0,
      publishAuthority: AUTHOR,
    });
    const warmDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-release-warm-'));
    const coldDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-release-cold-'));
    tempDirs.push(warmDataDir, coldDataDir);
    const warmStorePath = join(warmDataDir, 'oxigraph');
    const coldStorePath = join(coldDataDir, 'oxigraph');
    const startReleaseReceiver = async (
      name: string,
      dataDir: string,
      storePath: string,
      bootstrapConfig?: Rfc64PublicCatalogBootstrapConfigV1,
    ): Promise<DKGAgent> => {
      const chainAdapter = new FinalizedVmLoopbackMockChainAdapterV1(fixture);
      await chainAdapter.createOnChainContextGraph({
        accessPolicy: 0,
        publishPolicy: 0,
        nameHash,
      });
      return startNativeAgentWithOptions({
        name,
        existingDataDir: dataDir,
        finalizedRuntime: {
          rpcUrl: rpc.url,
          chainAdapter,
          initialSubscription: CONTEXT_GRAPH_ID,
        },
        bootstrap: bootstrapConfig,
        persistentStorePath: storePath,
      });
    };

    // The warm receiver exists before the publisher and before any catalog head.
    let warm = await startReleaseReceiver('release-proof-warm', warmDataDir, warmStorePath);
    const policyEnvelope = {
      issuer: CONTEXT_GRAPH_STORAGE,
      objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
      payload: policy,
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedContextGraphPolicyEnvelopeV1;
    const policyDigest = computeContextGraphPolicyObjectDigestV1(policyEnvelope);
    warm.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster: null,
    });
    const author = await startNativeAgent(
      'release-proof-author',
      NATIVE_DEPLOYMENT,
      undefined,
      undefined,
      {
        rpcUrl: rpc.url,
        chainAdapter: new FinalizedVmLoopbackMockChainAdapterV1(fixture),
      },
      {
        peers: [warm.peerId],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    );
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    author.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster: null,
    });
    const bootstrap: Rfc64PublicCatalogBootstrapConfigV1 = {
      acceptedPublicPolicies: [{
        policyEnvelope,
        targets: [{ authorAddress: AUTHOR, providers: [author.peerId] }],
      }],
      retryIntervalMs: 1_000,
    };
    await connectBothWays(author, warm);
    await warm.awaitInitialChainPoll();

    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: CONTEXT_GRAPH_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as const;
    const publicQuads = [
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: '',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
        graph: '',
      },
    ];
    const published = await author.recordConfirmedRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'release-proof-1' as never,
      publicQuads,
      seal: assertionSealFromCanonical(await authorSeal(kaNumbers[0], publicQuads)),
    });
    if (published === null) throw new Error('release proof catalog bridge was not enabled');

    const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
    const expectExactReleaseState = async (receiver: DKGAgent): Promise<void> => {
      expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
        published.currentCatalogHeadDigest,
      )).toBeNull();
      expect(receiver.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: scopeDigest,
        authorAddress: AUTHOR,
      })).toMatchObject({
        currentCatalogHeadDigest: published.currentCatalogHeadDigest,
        catalogVersion: published.catalogVersion,
        inventoryRowCount: '1',
      });
      for (const kaNumber of kaNumbers) {
        const vmGraph = contextGraphLayerUri(
          CONTEXT_GRAPH_ID,
          MemoryLayer.VerifiableMemory,
          AUTHOR,
          Number(kaNumber),
        );
        await expect((receiver as any).store.query(
          `SELECT ?s ?p ?o WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
        )).resolves.toMatchObject({
          type: 'bindings',
          bindings: expect.arrayContaining([
            expect.objectContaining({ s: 'https://example.org/alice' }),
          ]),
        });
      }
    };
    await vi.waitFor(() => {
      expect(warm.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: scopeDigest,
        authorAddress: AUTHOR,
      })?.currentCatalogHeadDigest).toBe(published.currentCatalogHeadDigest);
    }, { timeout: 20_000, interval: 100 });
    await expectExactReleaseState(warm);

    // The cold receiver starts only after the finalized head exists.
    let cold = await startReleaseReceiver(
      'release-proof-cold',
      coldDataDir,
      coldStorePath,
      bootstrap,
    );
    await connectBothWays(author, cold);
    await cold.awaitInitialChainPoll();
    await vi.waitFor(() => {
      expect(cold.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        providerPeerId: author.peerId,
        appliedHeadDigest: published.currentCatalogHeadDigest,
        inventoryRowCount: '1',
      });
    }, { timeout: 20_000, interval: 100 });
    await expectExactReleaseState(cold);

    // Prove durability before any provider or bootstrap path can repopulate the warm receiver.
    for (const receiver of [warm, cold]) {
      await receiver.stop();
      agents.splice(agents.indexOf(receiver), 1);
    }
    warm = await startReleaseReceiver(
      'release-proof-warm',
      warmDataDir,
      warmStorePath,
    );
    await warm.awaitInitialChainPoll();
    await expectExactReleaseState(warm);

    // Keep a separate restart assertion for the configured cold-bootstrap role.
    cold = await startReleaseReceiver(
      'release-proof-cold',
      coldDataDir,
      coldStorePath,
      bootstrap,
    );
    await connectBothWays(author, cold);
    await cold.awaitInitialChainPoll();
    await vi.waitFor(() => {
      expect(cold.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        outcome: 'applied',
        providerPeerId: author.peerId,
        appliedHeadDigest: published.currentCatalogHeadDigest,
        inventoryRowCount: '1',
      });
    }, { timeout: 20_000, interval: 100 });
    await Promise.all([
      expectExactReleaseState(warm),
      expectExactReleaseState(cold),
    ]);
  }, 90_000);

  it('exposes bounded typed failure evidence when wire scope differs from local deployment', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('mismatch-author'),
      startNativeAgent('mismatch-receiver', {
        ...NATIVE_DEPLOYMENT,
        networkId: 'base:8453' as NetworkIdV1,
      }),
    ]);
    receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, receiver);
    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    expect(published.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })).toBeNull();
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 0,
      failed: 1,
    });
    const failure = receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    );
    expect(failure).toEqual({
      catalogHeadDigest: published.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
    expect(Object.isFrozen(failure)).toBe(true);

    await receiver.stop();
    agents.splice(agents.indexOf(receiver), 1);
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
  }, 60_000);

  it('rejects a stale-network durable dedupe after restart under a new local pin', async () => {
    const receiverDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-native-repin-'));
    tempDirs.push(receiverDataDir);
    const [author, firstReceiver] = await Promise.all([
      startNativeAgent('repin-author'),
      startNativeAgent('repin-receiver', NATIVE_DEPLOYMENT, receiverDataDir),
    ]);
    firstReceiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, firstReceiver);
    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [firstReceiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    await firstReceiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(firstReceiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })?.currentCatalogHeadDigest).toBe(published.headObjectDigest);

    await firstReceiver.stop();
    agents.splice(agents.indexOf(firstReceiver), 1);
    const restartedReceiver = await startNativeAgent('repin-receiver', {
      ...NATIVE_DEPLOYMENT,
      networkId: 'base:8453' as NetworkIdV1,
    }, receiverDataDir);
    restartedReceiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, restartedReceiver);
    const delivery = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [restartedReceiver.peerId],
    });
    expect(delivery.announcedPeers).toEqual([restartedReceiver.peerId]);
    await restartedReceiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(restartedReceiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 0,
      dedupedAlreadyApplied: 0,
      failed: 1,
    });
    expect(restartedReceiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(restartedReceiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toEqual({
      catalogHeadDigest: published.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
  }, 60_000);

});

describe('RFC-64 M0 recovery scenarios', () => {
  it('registers the complete structural M0 recovery scenario set', () => {
    expect([...registeredRfc64M0RecoveryScenarios.keys()].sort()).toEqual(
      [...RFC64_M0_RECOVERY_SCENARIOS].sort(),
    );
  });

  for (const scenario of RFC64_M0_RECOVERY_SCENARIOS) {
    const spec = registeredRfc64M0RecoveryScenarios.get(scenario);
    if (spec === undefined) {
      throw new Error(`Missing RFC-64 M0 recovery scenario registration: ${scenario}`);
    }
    const scenarioIt = activeRfc64M0RecoveryScenario === undefined
      || activeRfc64M0RecoveryScenario === scenario
      ? it
      : it.skip;
    scenarioIt(spec.title, spec.handler, spec.timeout);
  }
});

async function authorSeal(
  kaNumber: bigint,
  publicQuads?: readonly Quad[],
): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const kaUal = `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`;
  const assertionMerkleRoot = publicQuads === undefined
    ? ASSERTION_ROOT
    : ethers.hexlify(computeFlatKCRootV10([...publicQuads], [])) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(NATIVE_DEPLOYMENT.assertedAtChainId),
    kav10Address: NATIVE_DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal,
    assertionVersion: '1',
    publicTripleCount: String(publicQuads?.length ?? 2),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function assertionSealFromCanonical(seal: CanonicalGraphScopedAuthorSealV1): AssertionSeal {
  return {
    merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
    authorAddress: seal.authorAddress,
    authorAttestationR: ethers.getBytes(seal.authorAttestationR),
    authorAttestationVS: ethers.getBytes(seal.authorAttestationVS),
    authorSchemeVersion: 1,
    chainId: BigInt(seal.assertedAtChainId),
    kav10Address: seal.assertedAtKav10Address,
    reservedKaId: BigInt(seal.reservedKaId),
    finalizedAtIso: seal.assertionFinalizedAt,
    contentScopeVersion: 2,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: Number(seal.publicTripleCount),
    ...(seal.privateMerkleRoot === null
      ? {}
      : { privateMerkleRoot: ethers.getBytes(seal.privateMerkleRoot) }),
    privateTripleCount: Number(seal.privateTripleCount),
    rootEntities: [],
  };
}
