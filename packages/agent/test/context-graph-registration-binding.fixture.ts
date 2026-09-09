import { vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { Rfc64SwmRecoveryRuntimeV1 } from
  '../src/dkg-agent-rfc64-swm-recovery-runtime.js';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
export const LOCAL_ID = 'selected-public-cg';
export const NAME_HASH = `0x${'ab'.repeat(32)}`;

type BindingAgentMethods = Pick<DKGAgent,
  | 'bindSubscriptionOnChainId'
  | 'bindSubscriptionReverseNameHashOnChainId'
  | 'clearSubscriptionReverseNameHashBinding'
  | 'resolveContextGraphNameHashBindingTarget'
  | 'resolveCurrentNameHashContextGraphBinding'
  | 'resolveContextGraphOnChainIdBinding'
  | 'getContextGraphOnChainId'
  | 'resolveContextGraphRegistrationBinding'
  | 'canReadContextGraph'
  | 'persistVmReconcileWatermark'
  | 'selfPrimeSubscriptionOnChainId'
  | 'resolveVmReconcileTarget'
  | 'setContextGraphSubscription'
  | 'handleKARegisteredNudge'
  | 'resolveOnChainParticipantAgents'
  | 'ensureContextGraphLocal'
  | 'persistJoinApprovalStateStrict'
  | 'normalizeMembershipPrincipal'
  | 'enqueueContextGraphMembershipPersistWrite'
  | 'enqueueContextGraphSubscriptionPersistWrite'
>;

/**
 * Build test state on the real composed DKGAgent prototype. Production mixin
 * wiring therefore has one owner (`applyMixins`); scenarios override only the
 * state/collaborators they exercise and remain type-checked against the public
 * method graph.
 */
function createBindingAgentHarness<TState extends object>(
  state: TState,
): TState & BindingAgentMethods {
  return Object.assign(
    Object.create(DKGAgent.prototype) as BindingAgentMethods,
    state,
  );
}

export function selectedFixture(resolved: bigint | null = 42n) {
  const query = vi.fn<TripleStore['query']>(async () => ({
    type: 'bindings',
    bindings: [],
  }));
  const resolveContextGraphIdByNameHash = vi.fn(async () => resolved);
  const subscription: {
    subscribed: boolean;
    synced: boolean;
    syncMode: 'always-on';
    coreHosted?: boolean;
    onChainId?: string;
    onChainHash?: string;
    lastReconciledOrdinal?: number;
  } = {
    subscribed: true,
    synced: false,
    syncMode: 'always-on',
    onChainHash: NAME_HASH,
  };
  const reconcileCursors = new Map<string, {
    watermark: number;
    ahead: Map<unknown, unknown>;
    scanOrdinal: number;
  }>();
  const chain: {
    resolveContextGraphIdByNameHash: typeof resolveContextGraphIdByNameHash;
    getContextGraphParticipantAgents?: (contextGraphId: bigint) => Promise<string[]>;
    isContextGraphActiveOnChain: (contextGraphId: bigint) => Promise<boolean>;
    getContextGraphAccessPolicy: (contextGraphId: bigint) => Promise<0 | 1>;
  } = {
    resolveContextGraphIdByNameHash,
    isContextGraphActiveOnChain: async () => true,
    getContextGraphAccessPolicy: async () => 1,
  };
  const rfc64SwmRecoveryRuntimeV1 = new Rfc64SwmRecoveryRuntimeV1({
    authority: {
      resolveRuntimeSelection: () => ({
        selectedContextGraphs: [],
        eligibleContextGraphs: [],
        subscriptionDriven: true,
      }),
      resolveConfigured: (contextGraphId) => ({
        contextGraphId,
        selected: false,
        eligible: false,
        active: true,
        mode: 'legacy',
        killSwitchActive: false,
        legacySyncAllowed: true,
        track2Enabled: false,
        authoringAllowed: false,
        reconciliationLane: 'legacy',
      }),
      resolveRecoveryConfig: () => undefined,
    },
    admission: { invalidateContextGraph: () => [] },
    cooldown: { deleteProvider: () => undefined },
  });
  const agent = createBindingAgentHarness({
    store: { query } as unknown as TripleStore,
    chain,
    rfc64SwmRecoveryRuntimeV1,
    subscribedContextGraphs: new Map([[LOCAL_ID, subscription]]),
    wireIdToLocalCgId: new Map([[NAME_HASH, LOCAL_ID]]),
    config: {
      syncContextGraphs: [],
      rfc64CatalogExecutionPlan: {
        killSwitchActive: false,
        legacyContextGraphs: [],
        track2ContextGraphs: [],
        selectedAuthority: {},
        selectedAuthorityByWireId: {},
        standaloneTrack2Enabled: false,
      },
    } as Record<string, unknown>,
    contextGraphWireId: (id: string) => id.toLowerCase(),
    contextGraphNameCommitment: (id: string) => id === LOCAL_ID ? NAME_HASH : id.toLowerCase(),
    localCgIdForWireId: (id: string) => id.toLowerCase() === NAME_HASH ? LOCAL_ID : id,
    invalidateListContextGraphsCache: vi.fn(),
    contextGraphBindingState: new ContextGraphBindingState(),
    reconcileCursors,
    selectedVmReconcileCursors: new Map(),
    persistContextGraphSubscriptionStrict: vi.fn(async () => undefined),
    emitReplication: vi.fn(),
    forceClearVmReconcileStateForContextGraph: vi.fn((localId: string) => {
      reconcileCursors.delete(localId);
    }),
    clearVmReconcileStateForContextGraph: vi.fn((localId: string) => {
      reconcileCursors.delete(localId);
    }),
    log: { info: vi.fn(), warn: vi.fn() },
    vmReconcileEnabled: () => false,
    vmReconcileLifecycleGeneration: 0,
    vmReconcileRotationClosed: false,
    resolveLocalCgIdByOnChainId: (_onChainId: string) => null as string | null,
    vmReconcileDispatcher: { triggerLive: vi.fn() },
    onChainParticipantAgentsCache: new Map(),
    contextGraphExists: vi.fn(async () => false),
    // These scenarios isolate historical name binding. Read-authority
    // admission is covered independently and must not make a synthetic,
    // chainless binding fixture fail before reaching the behavior under test.
    canReadContextGraph: vi.fn(async () => true),
    subscribeToContextGraph: vi.fn(),
  });
  return {
    agent,
    query,
    resolveContextGraphIdByNameHash,
    subscription,
  };
}

export function getOnChainId(
  fixture: ReturnType<typeof selectedFixture>,
  requestedId: string,
  options?: { signal?: AbortSignal },
): Promise<string | null> {
  return fixture.agent.getContextGraphOnChainId(requestedId, options);
}
