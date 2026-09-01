import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { projectContextGraphSubscriptionPersistence } from '../src/context-graph-subscription-policy.js';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';

const LOCAL_ID = 'selected-public-cg';
const NAME_HASH = `0x${'ab'.repeat(32)}`;

type BindingAgentMethods = Pick<DKGAgent,
  | 'bindSubscriptionOnChainId'
  | 'bindSubscriptionReverseNameHashOnChainId'
  | 'clearSubscriptionReverseNameHashBinding'
  | 'resolveContextGraphNameHashBindingTarget'
  | 'resolveCurrentNameHashContextGraphBinding'
  | 'resolveContextGraphOnChainIdBinding'
  | 'getContextGraphOnChainId'
  | 'resolveContextGraphNumericIdForPolicy'
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

function selectedFixture(resolved: bigint | null = 42n) {
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
  } = { resolveContextGraphIdByNameHash };
  const agent = createBindingAgentHarness({
    store: { query } as unknown as TripleStore,
    chain,
    subscribedContextGraphs: new Map([[LOCAL_ID, subscription]]),
    wireIdToLocalCgId: new Map([[NAME_HASH, LOCAL_ID]]),
    config: {
      syncContextGraphs: [],
      rfc64CatalogExecutionPlan: {
        killSwitchActive: false,
        legacyContextGraphs: [],
        track2ContextGraphs: [],
        selectedAuthority: {},
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
    subscribeToContextGraph: vi.fn(),
  });
  return {
    agent,
    query,
    resolveContextGraphIdByNameHash,
    subscription,
  };
}

function getOnChainId(
  fixture: ReturnType<typeof selectedFixture>,
  requestedId: string,
  options?: { signal?: AbortSignal },
): Promise<string | null> {
  return fixture.agent.getContextGraphOnChainId(requestedId, options);
}

describe('cold current-state Context Graph name binding', () => {
  it('resolves an explicit cleartext selection without ontology data', async () => {
    const fixture = selectedFixture();
    const signal = new AbortController().signal;

    await expect(getOnChainId(fixture, LOCAL_ID, { signal })).resolves.toBe('42');

    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledWith(
      NAME_HASH,
      { signal },
    );
    expect(fixture.subscription.onChainId).toBeUndefined();
    expect(fixture.agent.contextGraphBindingState.size).toBe(0);
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it('uses the same admitted target for a selected wire-hash request', async () => {
    const fixture = selectedFixture();
    await expect(getOnChainId(fixture, NAME_HASH)).resolves.toBe('42');
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledWith(NAME_HASH);
  });

  it('never lets an arbitrary unselected id trigger a current-state enumeration', async () => {
    const fixture = selectedFixture();
    await expect(getOnChainId(fixture, 'unselected-remote-cg')).resolves.toBeNull();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });

  it('does not let a passive non-admitted local record trigger enumeration', async () => {
    const fixture = selectedFixture();
    fixture.subscription.subscribed = false;
    await expect(getOnChainId(fixture, LOCAL_ID)).resolves.toBeNull();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });

  it('allows a host-only Core record to recover its current binding', async () => {
    const fixture = selectedFixture();
    fixture.subscription.subscribed = false;
    fixture.subscription.coreHosted = true;

    await expect(getOnChainId(fixture, LOCAL_ID)).resolves.toBe('42');
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledWith(NAME_HASH);
  });

  it('hashes the original spelling of a hash-shaped cleartext subscription id', async () => {
    const fixture = selectedFixture();
    const localId = `0x${'AB'.repeat(32)}`;
    const committedHash = `0x${'cd'.repeat(32)}`;
    fixture.agent.subscribedContextGraphs = new Map([[
      localId,
      { ...fixture.subscription, onChainHash: undefined },
    ]]);
    fixture.agent.localCgIdForWireId = (id: string) => id.toLowerCase();
    fixture.agent.contextGraphNameCommitment = vi.fn((id: string) =>
      id === localId ? committedHash : NAME_HASH);

    await expect(getOnChainId(fixture, localId)).resolves.toBe('42');
    expect(fixture.agent.contextGraphNameCommitment).toHaveBeenCalledWith(localId);
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledWith(committedHash);
  });

  it('retains the legacy ontology fallback after an authoritative current-state miss', async () => {
    const fixture = selectedFixture(null);
    fixture.query.mockResolvedValueOnce({
      type: 'bindings',
      bindings: [{ id: '"7"' }],
    });
    await expect(getOnChainId(fixture, LOCAL_ID)).resolves.toBe('7');
  });

  it('revalidates a reverse-derived 42 and fails closed when 42 plus 43 become ambiguous', async () => {
    const fixture = selectedFixture();
    await expect(getOnChainId(fixture, LOCAL_ID)).resolves.toBe('42');

    fixture.agent.bindSubscriptionReverseNameHashOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('ambiguous name hash: getNameHash commits it to 2 numeric ids'),
    );

    await expect(getOnChainId(fixture, LOCAL_ID)).rejects.toThrow(/ambiguous.*2 numeric ids/i);
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledTimes(2);
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it('keeps authoritative numeric bindings on the zero-RPC fast path', async () => {
    const fixture = selectedFixture();
    fixture.subscription.onChainId = '42';

    await expect(getOnChainId(fixture, LOCAL_ID)).resolves.toBe('42');
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it.each(['', '0', '00', '-1', '+1', ' 1', '1 '])(
    'never treats a non-canonical durable id %j as an authoritative binding',
    async (onChainId) => {
      const fixture = selectedFixture();
      fixture.subscription.onChainId = onChainId;

      expect(fixture.agent.contextGraphBindingState.currentBindingFor(
        LOCAL_ID,
        fixture.subscription,
      )).toBeUndefined();
      await expect(getOnChainId(fixture, LOCAL_ID)).resolves.toBeNull();
      expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    },
  );

  it.each(['""', '"0"', '"01"', '"-1"', '"1 "'])(
    'rejects malformed ontology-derived id %s before returning provenance',
    async (storedValue) => {
      const fixture = selectedFixture(null);
      fixture.query.mockResolvedValueOnce({
        type: 'bindings',
        bindings: [{ id: storedValue }],
      });

      await expect(fixture.agent.resolveContextGraphOnChainIdBinding(LOCAL_ID))
        .resolves.toBeNull();
    },
  );

  it('keeps reverse-derived identity and progress outside durable subscription state', () => {
    const fixture = selectedFixture();
    fixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );

    const projection = projectContextGraphSubscriptionPersistence({
      contextGraphId: LOCAL_ID,
      subscription: fixture.subscription,
      syncScoped: true,
    });
    expect(projection.action).toBe('save');
    if (projection.action !== 'save') throw new Error('expected durable member projection');
    expect(projection.record.onChainId).toBeUndefined();
    expect(projection.record.lastReconciledOrdinal).toBeUndefined();
  });

  it('keeps reverse VM watermarks process-local while authoritative targets persist', async () => {
    const reverseFixture = selectedFixture();
    reverseFixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      reverseFixture.subscription,
      '42',
      NAME_HASH,
    );
    const reverseCursor = { watermark: 0, ahead: new Map(), scanOrdinal: 0 };
    reverseFixture.agent.reconcileCursors.set(LOCAL_ID, reverseCursor);
    const reverseTarget = {
      kind: 'subscription' as const,
      sub: reverseFixture.subscription,
      bindingKind: 'reverse-name-hash' as const,
      onChainId: '42',
      nameHash: NAME_HASH,
      onChainCgId: 42n,
      cursor: reverseCursor,
      bindingGeneration: reverseFixture.agent.contextGraphBindingState.capture(LOCAL_ID),
      watermarkBefore: 0,
    };

    await reverseFixture.agent.persistVmReconcileWatermark(
      LOCAL_ID,
      5,
      reverseTarget,
    );

    expect(reverseFixture.agent.persistContextGraphSubscriptionStrict).not.toHaveBeenCalled();
    expect(reverseFixture.subscription.lastReconciledOrdinal).toBeUndefined();
    expect(reverseFixture.agent.emitReplication).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cursor-advance',
      fromWatermark: 0,
      toWatermark: 5,
    }));

    const authoritativeFixture = selectedFixture();
    authoritativeFixture.subscription.onChainId = '42';
    authoritativeFixture.subscription.lastReconciledOrdinal = 0;
    const authoritativeCursor = { watermark: 0, ahead: new Map(), scanOrdinal: 0 };
    authoritativeFixture.agent.reconcileCursors.set(LOCAL_ID, authoritativeCursor);
    const authoritativeTarget = {
      kind: 'subscription' as const,
      sub: authoritativeFixture.subscription,
      bindingKind: 'authoritative' as const,
      onChainId: '42',
      onChainCgId: 42n,
      cursor: authoritativeCursor,
      bindingGeneration: authoritativeFixture.agent.contextGraphBindingState.capture(LOCAL_ID),
      watermarkBefore: 0,
    };

    await authoritativeFixture.agent.persistVmReconcileWatermark(
      LOCAL_ID,
      5,
      authoritativeTarget,
    );

    expect(authoritativeFixture.agent.persistContextGraphSubscriptionStrict).toHaveBeenCalledWith(
      LOCAL_ID,
      expect.objectContaining({ onChainId: '42', lastReconciledOrdinal: 5 }),
      undefined,
      expect.any(Function),
    );
    expect(authoritativeFixture.subscription.lastReconciledOrdinal).toBe(5);
  });

  it('self-primes a reverse binding only in memory and revalidates before VM use', async () => {
    const fixture = selectedFixture();
    fixture.agent.vmReconcileEnabled = () => true;

    await expect(fixture.agent.selfPrimeSubscriptionOnChainId(
      LOCAL_ID,
      fixture.subscription,
    )).resolves.toBe('42');

    expect(fixture.agent.persistContextGraphSubscriptionStrict).not.toHaveBeenCalled();
    expect(fixture.subscription.onChainId).toBeUndefined();
    expect(fixture.agent.contextGraphBindingState.currentBindingFor(
      LOCAL_ID,
      fixture.subscription,
    )).toEqual({
      bindingKind: 'reverse-name-hash',
      onChainId: '42',
      nameHash: NAME_HASH,
    });

    await expect(fixture.agent.resolveVmReconcileTarget(
      LOCAL_ID,
    )).resolves.toMatchObject({ onChainId: '42', onChainCgId: 42n });
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledTimes(2);

    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('ambiguous name hash: getNameHash commits it to 2 numeric ids'),
    );
    await expect(fixture.agent.resolveVmReconcileTarget(
      LOCAL_ID,
    )).rejects.toThrow(/ambiguous.*2 numeric ids/i);
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledTimes(3);
  });

  it('uses the production reverse binder and resets stale VM progress only when the candidate changes', () => {
    const fixture = selectedFixture();
    fixture.agent.bindSubscriptionReverseNameHashOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    const generation = fixture.agent.contextGraphBindingState.capture(LOCAL_ID);
    fixture.subscription.lastReconciledOrdinal = 17;
    const cursor = { watermark: 17, ahead: new Map(), scanOrdinal: 18 };
    fixture.agent.reconcileCursors.set(LOCAL_ID, cursor);

    fixture.agent.bindSubscriptionReverseNameHashOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    expect(fixture.agent.contextGraphBindingState.capture(LOCAL_ID)).toBe(generation);
    expect(fixture.subscription.lastReconciledOrdinal).toBe(17);
    expect(fixture.agent.reconcileCursors.get(LOCAL_ID)).toBe(cursor);
    expect(fixture.agent.forceClearVmReconcileStateForContextGraph).not.toHaveBeenCalled();

    const nextHash = `0x${'ef'.repeat(32)}`;
    fixture.agent.bindSubscriptionReverseNameHashOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '43',
      nextHash,
    );
    expect(fixture.agent.contextGraphBindingState.currentBindingFor(LOCAL_ID, fixture.subscription)).toEqual({
      bindingKind: 'reverse-name-hash',
      onChainId: '43',
      nameHash: nextHash,
    });
    expect(fixture.agent.contextGraphBindingState.capture(LOCAL_ID)).toBe(generation + 1);
    expect(fixture.subscription.lastReconciledOrdinal).toBe(0);
    expect(fixture.agent.reconcileCursors.has(LOCAL_ID)).toBe(false);
    expect(fixture.agent.forceClearVmReconcileStateForContextGraph).toHaveBeenCalledOnce();
  });

  it('invalidates the reverse candidate and cursor when the subscription commitment changes', () => {
    const fixture = selectedFixture();
    fixture.agent.bindSubscriptionReverseNameHashOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    fixture.agent.reconcileCursors.set(LOCAL_ID, {
      watermark: 3,
      ahead: new Map(),
      scanOrdinal: 4,
    });
    const generation = fixture.agent.contextGraphBindingState.capture(LOCAL_ID);
    const nextHash = `0x${'ef'.repeat(32)}`;

    fixture.agent.setContextGraphSubscription(
      LOCAL_ID,
      { ...fixture.subscription, onChainHash: nextHash },
      { persist: false },
    );

    expect(fixture.agent.contextGraphBindingState.currentBindingFor(LOCAL_ID, fixture.subscription)).toBeUndefined();
    expect(fixture.agent.reconcileCursors.has(LOCAL_ID)).toBe(false);
    expect(fixture.agent.contextGraphBindingState.capture(LOCAL_ID)).toBe(generation + 1);
    expect(fixture.agent.forceClearVmReconcileStateForContextGraph).toHaveBeenCalledOnce();
    expect(fixture.agent.clearVmReconcileStateForContextGraph).not.toHaveBeenCalled();
  });

  it('clears a reverse candidate and cursor when the subscription gains an authoritative id', () => {
    const fixture = selectedFixture();
    fixture.agent.bindSubscriptionReverseNameHashOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    fixture.agent.reconcileCursors.set(LOCAL_ID, {
      watermark: 3,
      ahead: new Map(),
      scanOrdinal: 4,
    });
    const generation = fixture.agent.contextGraphBindingState.capture(LOCAL_ID);

    fixture.agent.setContextGraphSubscription(
      LOCAL_ID,
      { ...fixture.subscription, onChainId: '42' },
      { persist: false },
    );

    const promoted = fixture.agent.subscribedContextGraphs.get(LOCAL_ID);
    expect(fixture.agent.contextGraphBindingState.currentBindingFor(LOCAL_ID, promoted)).toEqual({
      bindingKind: 'authoritative',
      onChainId: '42',
    });
    expect(fixture.agent.contextGraphBindingState.size).toBe(0);
    expect(fixture.agent.reconcileCursors.has(LOCAL_ID)).toBe(false);
    expect(fixture.agent.contextGraphBindingState.capture(LOCAL_ID)).toBe(generation + 1);
    expect(fixture.agent.forceClearVmReconcileStateForContextGraph).toHaveBeenCalledOnce();
    expect(fixture.agent.clearVmReconcileStateForContextGraph).not.toHaveBeenCalled();
  });

  it('clears a reverse candidate and cursor when admission is removed and never revives it', () => {
    const fixture = selectedFixture();
    fixture.agent.bindSubscriptionReverseNameHashOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    fixture.agent.reconcileCursors.set(LOCAL_ID, {
      watermark: 3,
      ahead: new Map(),
      scanOrdinal: 4,
    });
    const generation = fixture.agent.contextGraphBindingState.capture(LOCAL_ID);

    fixture.agent.setContextGraphSubscription(
      LOCAL_ID,
      { ...fixture.subscription, subscribed: false, coreHosted: false },
      { persist: false },
    );

    const deactivated = fixture.agent.subscribedContextGraphs.get(LOCAL_ID);
    expect(fixture.agent.contextGraphBindingState.currentBindingFor(LOCAL_ID, deactivated))
      .toBeUndefined();
    expect(fixture.agent.reconcileCursors.has(LOCAL_ID)).toBe(false);
    expect(fixture.agent.contextGraphBindingState.capture(LOCAL_ID)).toBe(generation + 1);
    expect(fixture.agent.forceClearVmReconcileStateForContextGraph).toHaveBeenCalledOnce();
    expect(fixture.agent.clearVmReconcileStateForContextGraph).not.toHaveBeenCalled();

    fixture.agent.setContextGraphSubscription(
      LOCAL_ID,
      { ...deactivated, subscribed: true },
      { persist: false },
    );
    const reused = fixture.agent.subscribedContextGraphs.get(LOCAL_ID);
    expect(fixture.agent.contextGraphBindingState.currentBindingFor(LOCAL_ID, reused))
      .toBeUndefined();
    expect(fixture.agent.contextGraphBindingState.size).toBe(0);
  });

  it('uses ordinary VM cleanup when admission is removed without a reverse candidate', () => {
    const fixture = selectedFixture();
    fixture.agent.reconcileCursors.set(LOCAL_ID, {
      watermark: 3,
      ahead: new Map(),
      scanOrdinal: 4,
    });

    fixture.agent.setContextGraphSubscription(
      LOCAL_ID,
      { ...fixture.subscription, subscribed: false, coreHosted: false },
      { persist: false },
    );

    expect(fixture.agent.reconcileCursors.has(LOCAL_ID)).toBe(false);
    expect(fixture.agent.forceClearVmReconcileStateForContextGraph).not.toHaveBeenCalled();
    expect(fixture.agent.clearVmReconcileStateForContextGraph).toHaveBeenCalledOnce();
  });

  it('uses a reverse candidate only to schedule a live KACG nudge, then revalidates the VM target', async () => {
    const fixture = selectedFixture();
    fixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    fixture.agent.vmReconcileEnabled = () => true;
    fixture.agent.vmReconcileLifecycleGeneration = 1;
    fixture.agent.vmReconcileRotationClosed = false;
    fixture.agent.resolveLocalCgIdByOnChainId = () => null;
    const triggerLive = vi.fn();
    fixture.agent.vmReconcileDispatcher = { triggerLive };

    await expect(fixture.agent.handleKARegisteredNudge(
      '42',
      99n,
      {},
    )).resolves.toBe(LOCAL_ID);
    expect(triggerLive).toHaveBeenCalledWith(LOCAL_ID);
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();

    await expect(fixture.agent.resolveVmReconcileTarget(
      LOCAL_ID,
    )).resolves.toMatchObject({
      bindingKind: 'reverse-name-hash',
      onChainId: '42',
      nameHash: NAME_HASH,
    });
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledOnce();
  });

  it('revalidates a reverse candidate before participant-policy use', async () => {
    const fixture = selectedFixture();
    const getParticipants = vi.fn(async () => ['did:dkg:agent:alice']);
    fixture.agent.chain.getContextGraphParticipantAgents = getParticipants;
    fixture.agent.onChainParticipantAgentsCache = new Map();
    fixture.agent.log = { info: vi.fn(), warn: vi.fn() };
    fixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );

    await expect(fixture.agent.resolveOnChainParticipantAgents(
      LOCAL_ID,
    )).resolves.toEqual(['did:dkg:agent:alice']);
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledTimes(1);
    expect(getParticipants).toHaveBeenCalledWith(42n);

    fixture.agent.onChainParticipantAgentsCache.clear();
    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('ambiguous name hash: getNameHash commits it to 2 numeric ids'),
    );
    await expect(fixture.agent.resolveOnChainParticipantAgents(
      LOCAL_ID,
    )).resolves.toBeNull();
    expect(getParticipants).toHaveBeenCalledTimes(1);
  });

  it('never treats a numeric local name as an on-chain id after revalidation fails', async () => {
    const fixture = selectedFixture();
    const numericLocalId = '42';
    fixture.agent.subscribedContextGraphs = new Map([[numericLocalId, fixture.subscription]]);
    fixture.agent.contextGraphNameCommitment = () => NAME_HASH;
    fixture.agent.contextGraphBindingState.delete(LOCAL_ID);
    fixture.agent.contextGraphBindingState.bindReverseCandidate(
      numericLocalId,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('ambiguous name hash: getNameHash commits it to 2 numeric ids'),
    );
    const getParticipants = vi.fn(async () => ['did:dkg:agent:wrong']);
    fixture.agent.chain.getContextGraphParticipantAgents = getParticipants;
    fixture.agent.onChainParticipantAgentsCache = new Map();
    fixture.agent.log = { info: vi.fn(), warn: vi.fn() };

    await expect(fixture.agent.resolveOnChainParticipantAgents(
      numericLocalId,
    )).resolves.toBeNull();
    expect(getParticipants).not.toHaveBeenCalled();
  });

  it('promotes an authoritative event binding without erasing same-id VM progress', () => {
    const fixture = selectedFixture();
    fixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    fixture.subscription.lastReconciledOrdinal = 17;

    fixture.agent.bindSubscriptionOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '42',
    );

    expect(fixture.subscription.onChainId).toBe('42');
    expect(fixture.agent.contextGraphBindingState.currentBindingFor(
      LOCAL_ID,
      fixture.subscription,
    )).toEqual({
      bindingKind: 'authoritative',
      onChainId: '42',
    });
    expect(fixture.subscription.lastReconciledOrdinal).toBe(17);
    expect(fixture.agent.forceClearVmReconcileStateForContextGraph).not.toHaveBeenCalled();
    expect(fixture.agent.contextGraphBindingState.capture(LOCAL_ID)).toBe(2);
  });

  it('keeps a process-local reverse candidate outside an ensured subscription', async () => {
    const fixture = selectedFixture();
    const candidate = fixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    ).current;
    fixture.agent.contextGraphExists = vi.fn(async () => true);
    fixture.agent.subscribeToContextGraph = vi.fn();
    fixture.agent.setContextGraphSubscription = vi.fn();

    await fixture.agent.ensureContextGraphLocal(
      { id: LOCAL_ID, name: 'Selected public CG' },
    );

    expect(fixture.agent.setContextGraphSubscription).toHaveBeenCalledWith(
      LOCAL_ID,
      expect.objectContaining({ syncMode: 'always-on' }),
    );
    expect(fixture.agent.contextGraphBindingState.currentBindingFor(LOCAL_ID, fixture.subscription)).toBe(candidate);
  });

  it('omits a reverse-binding VM watermark from the strict join snapshot', async () => {
    const fixture = selectedFixture();
    const savedSubscriptions: unknown[] = [];
    fixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    fixture.agent.config = {
      contextGraphMembershipStore: {
        loadAll: vi.fn(async () => []),
        upsert: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      contextGraphSubscriptionStore: {
        load: vi.fn(async () => null),
        save: vi.fn(async (record: unknown) => { savedSubscriptions.push(record); }),
        delete: vi.fn(async () => undefined),
      },
    };
    fixture.agent.normalizeMembershipPrincipal = (_type: string, id: string) => id.toLowerCase();
    fixture.agent.enqueueContextGraphMembershipPersistWrite = (
      _key: string,
      work: () => Promise<void>,
    ) => work();
    fixture.agent.enqueueContextGraphSubscriptionPersistWrite = (
      _key: string,
      work: () => Promise<void>,
    ) => work();

    await fixture.agent.persistJoinApprovalStateStrict(
      LOCAL_ID,
      {
        contextGraphId: LOCAL_ID,
        principalType: 'agent',
        principalId: 'did:dkg:agent:alice',
        status: 'active',
      },
      fixture.subscription,
    );

    expect(savedSubscriptions).toEqual([
      expect.objectContaining({
        id: LOCAL_ID,
        onChainId: undefined,
        lastReconciledOrdinal: undefined,
      }),
    ]);
  });
});
