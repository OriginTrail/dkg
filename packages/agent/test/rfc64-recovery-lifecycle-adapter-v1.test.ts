import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  PROTOCOL_SYNC,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';

import type { DKGAgent } from '../src/dkg-agent.js';
import {
  resolveRfc64PeerSwmRecoveryPlanV1,
  resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1,
} from '../src/dkg-agent-rfc64-catalog-bootstrap.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import {
  createDkgAgentRfc64SwmRecoveryCoordinatorV1,
  type DkgAgentRfc64SwmRecoveryRuntimeV1,
} from '../src/rfc64/dkg-agent-swm-recovery-coordinator-v1.js';
import { SelectedSwmBootstrapAdmission } from '../src/sync/selected-swm-bootstrap-admission.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const AUTHOR = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const PUBLIC =
  '0x1111111111111111111111111111111111111111/recovery-public' as ContextGraphIdV1;
const PRIVATE =
  '0x2222222222222222222222222222222222222222/recovery-private' as ContextGraphIdV1;
const PROVIDER = '12D3KooWRfc64LifecycleProvider';

function privatePolicy(contextGraphId = PRIVATE): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '0',
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

function privateEnvelope(policy = privatePolicy()) {
  return {
    issuer: AUTHOR,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: policy,
    signatureEvidence: { kind: 'none' as const },
    signatureSuite: 'eip191-personal-sign-digest-v1' as const,
  };
}

function selectedResult() {
  return {
    kind: 'selected-shared-memory' as const,
    shared: {
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      insertedTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 2,
      checkpointAdvances: 0,
      emptyResponses: 2,
      droppedDataTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
      deniedPhases: 0,
    },
    selectedScopeComplete: true,
  };
}

interface LifecycleHarness {
  readonly agent: DKGAgent;
  readonly rfc64Config: LifecycleRfc64Config;
  readonly genericQueuedAt: Map<string, number>;
  readonly genericSync: ReturnType<typeof vi.fn>;
  readonly selectedSync: ReturnType<typeof vi.fn>;
  readonly admission: SelectedSwmBootstrapAdmission;
}

type LifecycleAcceptedPolicy = Readonly<{
  policyEnvelope: ReturnType<typeof unsignedOpenContextGraphPolicyEnvelopeV1>
    | ReturnType<typeof privateEnvelope>;
  targets: readonly [];
  completeSwmProviders: readonly string[];
}>;

type LifecycleRfc64Config = Readonly<{
  acceptedPolicies: readonly LifecycleAcceptedPolicy[];
  retryIntervalMs: 0;
}>;

function lifecycleHarness(options: Readonly<{
  acceptedPolicies: readonly LifecycleAcceptedPolicy[];
  selectedPublic?: readonly string[];
}>): LifecycleHarness {
  const genericQueuedAt = new Map<string, number>();
  const admission = new SelectedSwmBootstrapAdmission();
  const genericSync = vi.fn(async () => {});
  const selectedSync = vi.fn(async () => selectedResult());
  const rfc64Config: LifecycleRfc64Config = {
    acceptedPolicies: options.acceptedPolicies,
    retryIntervalMs: 0,
  };
  const state = {
    config: {
      syncContextGraphs: [...(options.selectedPublic ?? [])],
      syncOnConnectEnabled: true,
      syncSharedMemoryOnConnect: false,
      rfc64CatalogBootstrap: rfc64Config,
    },
    started: true,
    networkAdmissionCoordinator: { isAcceptedPeer: () => true },
    selectedSwmBootstrapAdmission: admission,
    catchupOnConnectAt: genericQueuedAt,
    lastSyncDisconnectedAt: new Map<string, number>(),
    lastSuccessfulSyncAt: new Map<string, number>(),
    syncReconcilerBackoff: new Map(),
    syncingPeers: new Set<string>(),
    skippedNoSyncPeers: new Set<string>(),
    lastSyncProgressAt: new Map<string, number>(),
    getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
    getSyncReconcilerProbe: vi.fn(async () => ({})),
    accountSyncAttemptWithReconciler: vi.fn(async (
      _peerId: string,
      _probe: unknown,
      attempt: (account: () => void) => Promise<unknown>,
    ) => attempt(() => {})),
    runSyncFromPeerOnConnect: genericSync,
    syncSelectedSharedMemoryFromPeerDetailed: selectedSync,
    syncOnConnectDisconnectBoundary: () => 0,
    log: { info: vi.fn() },
  };
  const agent = state as unknown as DKGAgent;
  const rfc64SwmRecoveryCoordinatorV1 = createDkgAgentRfc64SwmRecoveryCoordinatorV1(
    () => state as unknown as DkgAgentRfc64SwmRecoveryRuntimeV1,
  );
  Object.assign(state, {
    rfc64SwmRecoveryCoordinatorV1,
    syncRfc64AuthorizedSwmRecoveryPlanV1: (plan: Parameters<
      DKGAgent['syncRfc64AuthorizedSwmRecoveryPlanV1']
    >[0]) => LifecycleSyncMethods.prototype.syncRfc64AuthorizedSwmRecoveryPlanV1.call(agent, plan),
    tryRfc64SwmRecoveryPlanFromPeer: (...args: Parameters<
      DKGAgent['tryRfc64SwmRecoveryPlanFromPeer']
    >) => LifecycleSyncMethods.prototype.tryRfc64SwmRecoveryPlanFromPeer.call(agent, ...args),
    queueRfc64SwmRecoveryPlanFromPeerOnConnect: (...args: Parameters<
      DKGAgent['queueRfc64SwmRecoveryPlanFromPeerOnConnect']
    >) => LifecycleSyncMethods.prototype.queueRfc64SwmRecoveryPlanFromPeerOnConnect.call(
      agent,
      ...args
    ),
    queueSyncFromPeerOnConnect: (...args: Parameters<
      DKGAgent['queueSyncFromPeerOnConnect']
    >) => LifecycleSyncMethods.prototype.queueSyncFromPeerOnConnect.call(agent, ...args),
  });
  return {
    agent,
    rfc64Config,
    genericQueuedAt,
    genericSync,
    selectedSync,
    admission,
  };
}

afterEach(() => vi.useRealTimers());

describe('RFC-64 recovery plan lifecycle adapter', () => {
  it('keeps graph-complete provider scopes isolated', () => {
    const other = '12D3KooWOtherCompleteProvider';
    const config = {
      acceptedPolicies: [
        {
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(
            buildOpenOwnerContextGraphPolicyV1({
              networkId: NETWORK_ID,
              contextGraphId: PUBLIC,
              ownerAddress: AUTHOR,
            }),
          ),
          targets: [],
          completeSwmProviders: [PROVIDER],
        },
        {
          policyEnvelope: privateEnvelope(),
          targets: [],
          completeSwmProviders: [other],
        },
      ],
    };

    expect(resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1(config, PROVIDER))
      .toEqual([PUBLIC]);
    expect(resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1(config, other))
      .toEqual([PRIVATE]);
  });

  it('resolves one canonical mixed-lane plan for a shared provider', () => {
    const publicPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: PUBLIC,
      ownerAddress: AUTHOR,
    });
    expect(resolveRfc64PeerSwmRecoveryPlanV1({
      acceptedPolicies: [
        {
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(publicPolicy),
          targets: [],
          completeSwmProviders: [PROVIDER],
        },
        {
          policyEnvelope: privateEnvelope(),
          targets: [],
          completeSwmProviders: [PROVIDER],
        },
      ],
    }, PROVIDER)).toEqual({
      providerPeerId: PROVIDER,
      targets: [
        { contextGraphId: PUBLIC, lane: 'selected-public' },
        { contextGraphId: PRIVATE, lane: 'ordinary-private' },
      ].sort((left, right) => left.contextGraphId.localeCompare(right.contextGraphId)),
    });
  });

  it('rejects forged plans through the public try facade before lower sync', async () => {
    const publicPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: PUBLIC,
      ownerAddress: AUTHOR,
    });
    const harness = lifecycleHarness({
      selectedPublic: [PUBLIC],
      acceptedPolicies: [
        {
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(publicPolicy),
          targets: [],
          completeSwmProviders: [PROVIDER],
        },
        {
          policyEnvelope: privateEnvelope(),
          targets: [],
          completeSwmProviders: [PROVIDER],
        },
      ],
    });
    harness.admission.request(PROVIDER, [PUBLIC]);
    const valid = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PROVIDER,
      targets: [
        { contextGraphId: PUBLIC, lane: 'selected-public' as const },
        { contextGraphId: PRIVATE, lane: 'ordinary-private' as const },
      ],
    };

    await expect(harness.agent.tryRfc64SwmRecoveryPlanFromPeer(valid)).resolves.toBe('synced');
    for (const forged of [
      { ...valid, providerPeerId: '12D3KooWUnconfiguredProvider' },
      {
        ...valid,
        targets: [{ contextGraphId: 'unconfigured-private', lane: 'ordinary-private' as const }],
      },
      {
        ...valid,
        targets: [
          { contextGraphId: PUBLIC, lane: 'selected-public' as const },
          { contextGraphId: PRIVATE, lane: 'selected-public' as const },
        ],
      },
    ]) {
      await expect(harness.agent.tryRfc64SwmRecoveryPlanFromPeer(forged))
        .rejects.toThrow('not authorized by current configuration');
    }
    expect(harness.selectedSync).toHaveBeenCalledOnce();
  });

  it('runs private recovery when a generic non-SWM queue marker was recorded first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const harness = lifecycleHarness({
      acceptedPolicies: [{
        policyEnvelope: privateEnvelope(),
        targets: [],
        completeSwmProviders: [PROVIDER],
      }],
    });
    // Simulate connection:open winning startup order. Generic sync is enabled
    // but configured to omit SWM, so its queue cannot represent equivalent
    // RFC-64 recovery work.
    expect(harness.agent.queueSyncFromPeerOnConnect(PROVIDER, vi.fn(), 0)).toBe(true);
    expect(harness.genericQueuedAt.get(PROVIDER)).toBe(100_000);
    const plan = resolveRfc64PeerSwmRecoveryPlanV1(
      harness.rfc64Config,
      PROVIDER,
    );

    expect(harness.agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      plan,
      vi.fn(),
      0,
    )).toBe(true);
    // The lifecycle facade must reuse the one stateful coordinator. Rebuilding
    // it here would lose the private cooldown ledger and schedule twice.
    expect(harness.agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      plan,
      vi.fn(),
      0,
    )).toBe(false);
    await vi.runAllTimersAsync();

    expect(harness.genericSync).toHaveBeenCalledOnce();
    expect(harness.selectedSync).toHaveBeenCalledOnce();
  });
});
