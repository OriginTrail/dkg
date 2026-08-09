import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { projectContextGraphSubscriptionPersistence } from '../src/context-graph-subscription-policy.js';

const LOCAL_ID = 'selected-public-cg';
const NAME_HASH = `0x${'ab'.repeat(32)}`;

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
    reverseNameHashOnChainId?: string;
    lastReconciledOrdinal?: number;
  } = {
    subscribed: true,
    synced: false,
    syncMode: 'always-on',
    onChainHash: NAME_HASH,
  };
  const agent: any = {
    store: { query } as unknown as TripleStore,
    chain: { resolveContextGraphIdByNameHash },
    subscribedContextGraphs: new Map([[LOCAL_ID, subscription]]),
    contextGraphWireId: (id: string) => id.toLowerCase(),
    contextGraphNameCommitment: (id: string) => id === LOCAL_ID ? NAME_HASH : id.toLowerCase(),
    localCgIdForWireId: (id: string) => id.toLowerCase() === NAME_HASH ? LOCAL_ID : id,
    invalidateListContextGraphsCache: vi.fn(),
    contextGraphBindingGenerations: new Map<string, number>(),
    reconcileCursors: new Map(),
    persistContextGraphSubscriptionStrict: vi.fn(async () => undefined),
    bindSubscriptionOnChainId: vi.fn((
      _localId: string,
      sub: typeof subscription,
      onChainId: string,
    ) => {
      delete sub.reverseNameHashOnChainId;
      sub.onChainId = onChainId;
    }),
    bindSubscriptionReverseNameHashOnChainId: vi.fn((
      _localId: string,
      sub: typeof subscription,
      onChainId: string,
    ) => { sub.reverseNameHashOnChainId = onChainId; }),
  };
  agent.resolveContextGraphNameHashBindingTarget = (requestedId: string) =>
    ContextGraphResolveMethods.prototype.resolveContextGraphNameHashBindingTarget.call(
      agent,
      requestedId,
    );
  agent.resolveCurrentNameHashContextGraphBinding = (
    requestedId: string,
    options?: { signal?: AbortSignal },
  ) => ContextGraphResolveMethods.prototype.resolveCurrentNameHashContextGraphBinding.call(
    agent,
    requestedId,
    options,
  );
  agent.resolveContextGraphOnChainIdBinding = (
    requestedId: string,
    options?: { signal?: AbortSignal; source?: string },
  ) => ContextGraphRegistryMethods.prototype.resolveContextGraphOnChainIdBinding.call(
    agent,
    requestedId,
    options,
  );
  agent.getContextGraphOnChainId = (
    requestedId: string,
    options?: { signal?: AbortSignal; source?: string },
  ) => ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
    agent,
    requestedId,
    options,
  );
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
  return ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
    fixture.agent,
    requestedId,
    options,
  );
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
    expect(fixture.subscription.reverseNameHashOnChainId).toBeUndefined();
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

  it('never durably projects a reverse-derived id or its binding-specific watermark', () => {
    const fixture = selectedFixture();
    fixture.subscription.reverseNameHashOnChainId = '42';
    fixture.subscription.lastReconciledOrdinal = 17;

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

  it('self-primes a reverse binding only in memory and revalidates before VM use', async () => {
    const fixture = selectedFixture();
    fixture.agent.vmReconcileEnabled = () => true;

    await expect(SwmHostModeMethods.prototype.selfPrimeSubscriptionOnChainId.call(
      fixture.agent,
      LOCAL_ID,
      fixture.subscription,
    )).resolves.toBe('42');

    expect(fixture.agent.persistContextGraphSubscriptionStrict).not.toHaveBeenCalled();
    expect(fixture.subscription.onChainId).toBeUndefined();
    expect(fixture.subscription.reverseNameHashOnChainId).toBe('42');

    await expect(SwmHostModeMethods.prototype.resolveVmReconcileTarget.call(
      fixture.agent,
      LOCAL_ID,
    )).resolves.toMatchObject({ onChainId: '42', onChainCgId: 42n });
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledTimes(2);

    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('ambiguous name hash: getNameHash commits it to 2 numeric ids'),
    );
    await expect(SwmHostModeMethods.prototype.resolveVmReconcileTarget.call(
      fixture.agent,
      LOCAL_ID,
    )).rejects.toThrow(/ambiguous.*2 numeric ids/i);
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledTimes(3);
  });

  it('revalidates a reverse candidate before participant-policy use', async () => {
    const fixture = selectedFixture();
    const getParticipants = vi.fn(async () => ['did:dkg:agent:alice']);
    fixture.agent.chain.getContextGraphParticipantAgents = getParticipants;
    fixture.agent.onChainParticipantAgentsCache = new Map();
    fixture.agent.log = { warn: vi.fn() };
    fixture.subscription.reverseNameHashOnChainId = '42';

    await expect(ContextGraphResolveMethods.prototype.resolveOnChainParticipantAgents.call(
      fixture.agent,
      LOCAL_ID,
    )).resolves.toEqual(['did:dkg:agent:alice']);
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledTimes(1);
    expect(getParticipants).toHaveBeenCalledWith(42n);

    fixture.agent.onChainParticipantAgentsCache.clear();
    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('ambiguous name hash: getNameHash commits it to 2 numeric ids'),
    );
    await expect(ContextGraphResolveMethods.prototype.resolveOnChainParticipantAgents.call(
      fixture.agent,
      LOCAL_ID,
    )).resolves.toBeNull();
    expect(getParticipants).toHaveBeenCalledTimes(1);
  });

  it('never treats a numeric local name as an on-chain id after revalidation fails', async () => {
    const fixture = selectedFixture();
    const numericLocalId = '42';
    fixture.agent.subscribedContextGraphs = new Map([[numericLocalId, fixture.subscription]]);
    fixture.agent.contextGraphNameCommitment = () => NAME_HASH;
    fixture.subscription.reverseNameHashOnChainId = '42';
    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('ambiguous name hash: getNameHash commits it to 2 numeric ids'),
    );
    const getParticipants = vi.fn(async () => ['did:dkg:agent:wrong']);
    fixture.agent.chain.getContextGraphParticipantAgents = getParticipants;
    fixture.agent.onChainParticipantAgentsCache = new Map();
    fixture.agent.log = { warn: vi.fn() };

    await expect(ContextGraphResolveMethods.prototype.resolveOnChainParticipantAgents.call(
      fixture.agent,
      numericLocalId,
    )).resolves.toBeNull();
    expect(getParticipants).not.toHaveBeenCalled();
  });

  it('promotes an authoritative event binding without erasing same-id VM progress', () => {
    const fixture = selectedFixture();
    fixture.subscription.reverseNameHashOnChainId = '42';
    fixture.subscription.lastReconciledOrdinal = 17;
    fixture.agent.forceClearVmReconcileStateForContextGraph = vi.fn();
    fixture.agent.log = { info: vi.fn() };

    SwmHostModeMethods.prototype.bindSubscriptionOnChainId.call(
      fixture.agent,
      LOCAL_ID,
      fixture.subscription,
      '42',
    );

    expect(fixture.subscription.onChainId).toBe('42');
    expect(fixture.subscription.reverseNameHashOnChainId).toBeUndefined();
    expect(fixture.subscription.lastReconciledOrdinal).toBe(17);
    expect(fixture.agent.forceClearVmReconcileStateForContextGraph).not.toHaveBeenCalled();
  });

  it('preserves a process-local reverse candidate when ensuring an existing CG', async () => {
    const fixture = selectedFixture();
    fixture.subscription.reverseNameHashOnChainId = '42';
    fixture.agent.contextGraphExists = vi.fn(async () => true);
    fixture.agent.subscribeToContextGraph = vi.fn();
    fixture.agent.setContextGraphSubscription = vi.fn();

    await ContextGraphRegistryMethods.prototype.ensureContextGraphLocal.call(
      fixture.agent,
      { id: LOCAL_ID, name: 'Selected public CG' },
    );

    expect(fixture.agent.setContextGraphSubscription).toHaveBeenCalledWith(
      LOCAL_ID,
      expect.objectContaining({ reverseNameHashOnChainId: '42', syncMode: 'always-on' }),
    );
  });

  it('omits a reverse-binding VM watermark from the strict join snapshot', async () => {
    const fixture = selectedFixture();
    const savedSubscriptions: unknown[] = [];
    fixture.subscription.reverseNameHashOnChainId = '42';
    fixture.subscription.lastReconciledOrdinal = 17;
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

    await LifecycleSyncMethods.prototype.persistJoinApprovalStateStrict.call(
      fixture.agent,
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
