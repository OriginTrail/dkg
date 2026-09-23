/**
 * Adoption of a verified cleartext id for a Context Graph this node knows only
 * by its on-chain name hash (Base-mainnet Context Graph #33, 2026-09-23), and
 * the restart contract for a `--save`d hash subscription.
 */
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { SyncTargetSupersededError } from '../src/sync/error-tags.js';
import type {
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
} from '../src/dkg-agent-types.js';
import { DKGAgent } from '../src/index.js';
import { PROTOCOL_CONTEXT_GRAPH_NAME } from '../src/context-graph-name-protocol.js';
import {
  contextGraphNameHashOnlyMessage,
  partitionSupersededContextGraphNamePlaceholders,
} from '../src/dkg-agent-cg-name-resolution.js';

const CLEARTEXT = 'acme-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
const ON_CHAIN_ID = '33';

interface RecordingStore extends ContextGraphSubscriptionStore {
  readonly saved: ContextGraphSubscriptionRecord[];
  readonly deleted: string[];
}

function recordingStore(rows: ContextGraphSubscriptionRecord[] = []): RecordingStore {
  const saved: ContextGraphSubscriptionRecord[] = [];
  const deleted: string[] = [];
  return {
    saved,
    deleted,
    loadAll: async () => rows,
    save: async (record) => { saved.push(record); },
    delete: async (id) => { deleted.push(id); },
  };
}

let agent: DKGAgent | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (agent) await agent.stop().catch(() => undefined);
  agent = null;
});

/** Context Graph 33 on chain; `committedNameHash: null` opts out of a name commitment. */
async function chainWithContextGraph33(
  accessPolicy: 0 | 1 = 0,
  committedNameHash: string | null = NAME_HASH,
): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: BigInt(ON_CHAIN_ID) });
  await chain.createOnChainContextGraph({
    accessPolicy,
    publishPolicy: 1,
    ...(committedNameHash === null ? {} : { nameHash: committedNameHash }),
  } as never);
  return chain;
}

/** A created (not started) agent with inert networking, like core-fills-gap's fixture. */
async function boot(options: {
  store?: RecordingStore;
  accessPolicy?: 0 | 1;
  committedNameHash?: string | null;
  syncContextGraphs?: string[];
  rehydrationEnabled?: boolean;
} = {}): Promise<DKGAgent & Record<string, any>> {
  agent = await DKGAgent.create({
    name: 'NameHashAdoption',
    chainAdapter: await chainWithContextGraph33(
      options.accessPolicy ?? 0,
      options.committedNameHash === undefined ? NAME_HASH : options.committedNameHash,
    ),
    contextGraphSubscriptionStore: options.store ?? recordingStore(),
    syncContextGraphs: options.syncContextGraphs,
    ...(options.rehydrationEnabled === undefined
      ? {}
      : { contextGraphSubscriptionRehydrationEnabled: options.rehydrationEnabled }),
  });
  const internals = agent as DKGAgent & Record<string, any>;
  internals.node = { peerId: '12D3KooWNameHashAdoptionTestPeer', libp2p: { getPeers: () => [] } };
  const topics = new Set<string>();
  internals.gossip = {
    subscribe: (topic: string) => { topics.add(topic); },
    unsubscribe: (topic: string) => { topics.delete(topic); },
    onMessage: () => undefined,
    offMessage: () => undefined,
    publish: async () => undefined,
    subscribedTopics: [],
    topics,
  };
  return internals;
}

/** The #33 edge: a discovered placeholder, subscribed by hash with `--save`. */
function subscribeByNameHash(internals: Record<string, any>): void {
  expect(internals.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, ON_CHAIN_ID)).toBe(NAME_HASH);
  internals.onChainAccessPolicyCache.set(ON_CHAIN_ID, 0);
  internals.subscribeToContextGraph(NAME_HASH, { syncMode: 'always-on' });
  expect(internals.subscribedContextGraphs.get(NAME_HASH)).toMatchObject({
    subscribed: true,
    onChainHash: NAME_HASH,
    onChainId: ON_CHAIN_ID,
  });
}

/** Durable writes are queued asynchronously; wait for them, not for a fixed time. */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('adopting a verified cleartext id', () => {
  it('promotes a durable hash subscription to the cleartext id everywhere', async () => {
    const store = recordingStore();
    const internals = await boot({ store });
    subscribeByNameHash(internals);
    await waitFor(() => store.saved.some((row) => row.id === NAME_HASH));
    expect(internals.config.syncContextGraphs).toContain(NAME_HASH);

    const target = { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID };
    await expect(internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-protocol'))
      .resolves.toBe(true);
    await waitFor(() => store.deleted.includes(NAME_HASH)
      && store.saved.some((row) => row.id === CLEARTEXT && row.onChainHash === NAME_HASH));

    expect(internals.subscribedContextGraphs.has(NAME_HASH)).toBe(false);
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({
      subscribed: true,
      syncMode: 'always-on',
      onChainId: ON_CHAIN_ID,
      onChainHash: NAME_HASH,
    });
    // Reverse index, sync scope, gossip and durable state all follow.
    expect(internals.wireIdToLocalCgId.get(NAME_HASH)).toBe(CLEARTEXT);
    expect(internals.config.syncContextGraphs).toContain(CLEARTEXT);
    expect(internals.config.syncContextGraphs).not.toContain(NAME_HASH);
    expect(internals.gossipRegistered.has(CLEARTEXT)).toBe(true);
    expect(internals.gossipRegistered.has(NAME_HASH)).toBe(false);
    // Member topics move to the cleartext id. (The SWM topic is keyed by the
    // wire hash for both ids by design, so it is not asserted here.)
    const topics = [...internals.gossip.topics] as string[];
    for (const suffix of ['finalization', 'update', 'app']) {
      expect(topics).toContain(`dkg/context-graph/${CLEARTEXT}/${suffix}`);
      expect(topics).not.toContain(`dkg/context-graph/${NAME_HASH}/${suffix}`);
    }
    expect(store.deleted).toContain(NAME_HASH);
    expect(store.saved.filter((row) => row.id === CLEARTEXT).at(-1)).toMatchObject({
      subscribed: true,
      onChainId: ON_CHAIN_ID,
      onChainHash: NAME_HASH,
    });
    expect(internals.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
    // RFC-64 catalog digest, curator lookup and exact VM fetch key off the
    // local id resolved from the on-chain id: it is the cleartext id now.
    expect(internals.resolveLocalCgIdByOnChainId(BigInt(ON_CHAIN_ID))).toBe(CLEARTEXT);
  });

  it('is idempotent under concurrent answers', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    const target = { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID };
    const results = await Promise.all([
      internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-protocol'),
      internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology'),
      internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'local-store'),
    ]);
    expect(results).toEqual([true, true, true]);
    expect([...internals.subscribedContextGraphs.keys()].filter((id) => id === CLEARTEXT || id === NAME_HASH))
      .toEqual([CLEARTEXT]);
  });

  it('rejects a candidate whose commitment does not match', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    await expect(internals.adoptVerifiedContextGraphCleartext(
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
      'acme-fun-fact',
      'peer-protocol',
    )).resolves.toBe(false);
    expect(internals.subscribedContextGraphs.get(NAME_HASH)).toMatchObject({ subscribed: true });
    expect(internals.subscribedContextGraphs.has('acme-fun-fact')).toBe(false);
  });

  it('never merges two different on-chain graphs', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    internals.setContextGraphSubscription(CLEARTEXT, { subscribed: false, synced: false, onChainId: '99' });
    // Re-assert the placeholder (its creation event replayed, say): the reverse
    // index points at it again, so only the slot guard stands in the way.
    internals.setContextGraphSubscription(NAME_HASH, { ...internals.subscribedContextGraphs.get(NAME_HASH) });
    expect(internals.contextGraphNamePlaceholder(NAME_HASH)).not.toBeNull();
    const warn = vi.spyOn(internals.log, 'warn');
    await expect(internals.adoptVerifiedContextGraphCleartext(
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
      CLEARTEXT,
      'peer-protocol',
    )).resolves.toBe(false);
    expect(warn.mock.calls.some(([, message]) => String(message).includes(`Not adopting "${CLEARTEXT}"`))).toBe(true);
    expect(internals.subscribedContextGraphs.get(NAME_HASH)).toMatchObject({ onChainId: ON_CHAIN_ID, subscribed: true });
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ onChainId: '99' });
  });

  it('merges a core-hosted placeholder into an existing cleartext row and reconciles it', async () => {
    const store = recordingStore();
    const internals = await boot({ store });
    // An operator's on-demand cleartext row, not bound on-chain yet...
    internals.setContextGraphSubscription(CLEARTEXT, { subscribed: true, synced: false, syncMode: 'on-demand' });
    // ...and a hosting record for the same graph, seen only by its name hash.
    internals.setContextGraphSubscription(NAME_HASH, {
      subscribed: false,
      synced: false,
      coreHosted: true,
      onChainId: ON_CHAIN_ID,
      onChainHash: NAME_HASH,
    });
    await waitFor(() => store.saved.some((row) => row.id === NAME_HASH));
    expect(internals.contextGraphNameResolutionTargets()).toEqual([{ nameHash: NAME_HASH, onChainId: ON_CHAIN_ID }]);
    const reconciled: string[] = [];
    internals.vmReconcileScheduling = { triggerLive: (id: string) => { reconciled.push(id); } };

    await expect(internals.adoptVerifiedContextGraphCleartext(
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
      CLEARTEXT,
      'peer-ontology',
    )).resolves.toBe(true);
    expect(internals.subscribedContextGraphs.has(NAME_HASH)).toBe(false);
    // The operator's own settings stay; the binding and the hosting obligation join them.
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({
      subscribed: true,
      syncMode: 'on-demand',
      coreHosted: true,
      onChainId: ON_CHAIN_ID,
      onChainHash: NAME_HASH,
    });
    expect(internals.wireIdToLocalCgId.get(NAME_HASH)).toBe(CLEARTEXT);
    // Nothing was subscribed under the hash, so the VM reconcile starts at once.
    expect(reconciled).toEqual([CLEARTEXT]);
    await waitFor(() => store.deleted.includes(NAME_HASH));
  });

  it('lets a later answer adopt after an earlier adoption failed', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    vi.spyOn(internals, 'unsubscribeFromContextGraph')
      .mockImplementationOnce(() => { throw new Error('gossip layer restarting'); });
    const target = { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID };
    const first = internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-protocol');
    const second = internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology');
    await expect(first).rejects.toThrow('gossip layer restarting');
    await expect(second).resolves.toBe(true);
    expect(internals.subscribedContextGraphs.has(NAME_HASH)).toBe(false);
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ subscribed: true, onChainHash: NAME_HASH });
  });

  it('retires the durable rows of a subscribed placeholder that any cleartext writer promotes', async () => {
    const store = recordingStore();
    const internals = await boot({ store });
    subscribeByNameHash(internals);
    await waitFor(() => store.saved.some((row) => row.id === NAME_HASH));
    const deleteMember = vi.spyOn(internals, 'deleteContextGraphMember');
    // A writer that names the cleartext id directly (a join, a hosting record).
    internals.setContextGraphSubscription(CLEARTEXT, { subscribed: true, synced: false, syncMode: 'always-on' });
    expect(internals.subscribedContextGraphs.has(NAME_HASH)).toBe(false);
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ onChainId: ON_CHAIN_ID, onChainHash: NAME_HASH });
    expect(deleteMember).toHaveBeenCalledWith(NAME_HASH, 'node', internals.peerId);
    await waitFor(() => store.deleted.includes(NAME_HASH));
  });

  it('never mints a second identity when the adopted hash is subscribed again', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    await internals.adoptVerifiedContextGraphCleartext(
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
      CLEARTEXT,
      'peer-protocol',
    );
    // e.g. `dkg subscribe <hash>` again, or a route racing the resolver.
    const subscription = internals.subscribeToContextGraph(NAME_HASH, { syncMode: 'always-on' });
    expect(subscription).toMatchObject({ subscribed: true, onChainHash: NAME_HASH });
    expect(internals.subscribedContextGraphs.has(NAME_HASH)).toBe(false);
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ subscribed: true });
    expect(internals.config.syncContextGraphs).not.toContain(NAME_HASH);
  });

  it('moves the subscription when the operator subscribes the cleartext id directly', async () => {
    const store = recordingStore();
    const internals = await boot({ store });
    subscribeByNameHash(internals);
    internals.subscribeToContextGraph(CLEARTEXT, { syncMode: 'always-on' });
    await waitFor(() => store.deleted.includes(NAME_HASH));
    expect(internals.subscribedContextGraphs.has(NAME_HASH)).toBe(false);
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({
      subscribed: true,
      onChainHash: NAME_HASH,
      onChainId: ON_CHAIN_ID,
    });
    expect(internals.gossipRegistered.has(NAME_HASH)).toBe(false);
    expect(internals.config.syncContextGraphs).not.toContain(NAME_HASH);
    expect(store.deleted).toContain(NAME_HASH);
  });
});

/** The agent's own resolver, driven through its real dependencies. */
describe('a declined adoption, through the agent resolver', () => {
  const lifetimes: AbortController[] = [];
  afterEach(() => {
    for (const lifetime of lifetimes.splice(0)) lifetime.abort();
  });

  /** What `start()` does for the resolver, on the booted fixture's inert networking. */
  function startNameResolver(internals: Record<string, any>): void {
    const lifetime = new AbortController();
    lifetimes.push(lifetime);
    internals.router = { register: () => undefined };
    internals.node.libp2p.peerId = { toString: () => internals.node.peerId };
    internals.node.libp2p.addEventListener = () => undefined;
    internals.startContextGraphNameResolution(lifetime.signal);
  }

  /** The graph's public definition in this node's own ontology graph: the local-store source. */
  async function seedLocalDefinition(internals: Record<string, any>): Promise<void> {
    await internals.store.insert([{
      graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
      subject: `did:dkg:context-graph:${CLEARTEXT}`,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
    }]);
  }

  it('records the two-slot binding conflict as declined and never retries it in the background', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    internals.setContextGraphSubscription(CLEARTEXT, { subscribed: false, synced: false, onChainId: '99' });
    internals.setContextGraphSubscription(NAME_HASH, { ...internals.subscribedContextGraphs.get(NAME_HASH) });
    // The placeholder still wants a cleartext id: it is a live target.
    expect(internals.contextGraphNameResolutionTargets()).toEqual([{ nameHash: NAME_HASH, onChainId: ON_CHAIN_ID }]);
    await seedLocalDefinition(internals);
    const warn = vi.spyOn(internals.log, 'warn');
    const conflictWarnings = () => warn.mock.calls.filter(([, message]) => (
      String(message).includes(`Not adopting "${CLEARTEXT}"`)
    ));
    const adopt = vi.spyOn(internals, 'adoptVerifiedContextGraphCleartext');
    const findLocal = vi.spyOn(internals, 'findLocalContextGraphNameCandidates');
    const passes = vi.spyOn(internals, 'contextGraphNameResolutionTargets');
    startNameResolver(internals);

    await expect(internals.resolveContextGraphNameHashNow(NAME_HASH)).resolves.toBeNull();
    const declined = {
      state: 'declined',
      nameHash: NAME_HASH,
      onChainId: ON_CHAIN_ID,
      contextGraphId: CLEARTEXT,
      source: 'local-store',
    };
    expect(internals.getContextGraphNameResolutionStatus()).toEqual([
      { ...declined, declinedAt: expect.any(Number), nextCheckAt: expect.any(Number) },
    ]);
    expect(adopt).toHaveBeenCalledTimes(1);
    await expect(adopt.mock.results[0]!.value).resolves.toBe(false);
    expect(conflictWarnings()).toHaveLength(1);
    expect(internals.subscribedContextGraphs.get(NAME_HASH)).toMatchObject({ onChainId: ON_CHAIN_ID, subscribed: true });
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ onChainId: '99' });
    // The operator is told why it cannot sync, not to wait for a peer.
    expect(internals.describeContextGraphIdentity(NAME_HASH)).toMatchObject({
      state: 'name-hash-only',
      bindingConflict: true,
      message: expect.stringContaining('already bound to a different on-chain Context Graph'),
    });

    // A background pass over the still-subscribed row leaves it alone: no
    // local-store scan, no adoption, no repeated warning.
    const passesBefore = passes.mock.calls.length;
    internals.requestContextGraphNameResolutionFor(NAME_HASH);
    await waitFor(() => passes.mock.calls.length > passesBefore);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(findLocal).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(conflictWarnings()).toHaveLength(1);

    // Subscribing again is an explicit request, which checks once more.
    await expect(internals.resolveContextGraphNameHashNow(NAME_HASH)).resolves.toBeNull();
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(internals.getContextGraphNameResolutionStatus()).toEqual([expect.objectContaining(declined)]);

    // The conflicting row loses its binding (a binding refresh, say): the
    // refusal no longer holds, the note stops reporting a conflict, and an
    // ordinary background pass adopts.
    internals.subscribedContextGraphs.set(CLEARTEXT, {
      ...internals.subscribedContextGraphs.get(CLEARTEXT),
      onChainId: undefined,
    });
    expect(internals.describeContextGraphIdentity(NAME_HASH)).not.toHaveProperty('bindingConflict');
    internals.requestContextGraphNameResolutionFor(NAME_HASH);
    await waitFor(() => internals.resolveContextGraphIdAlias(NAME_HASH) === CLEARTEXT);
    expect(adopt).toHaveBeenCalledTimes(3);
    expect(internals.getContextGraphNameResolutionStatus()).toEqual([
      expect.objectContaining({ state: 'resolved', nameHash: NAME_HASH, contextGraphId: CLEARTEXT }),
    ]);
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ onChainId: ON_CHAIN_ID, onChainHash: NAME_HASH });
  });

  it('records nothing for the old binding when the row is re-bound while the attempt runs', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    await seedLocalDefinition(internals);
    const findLocal = internals.findLocalContextGraphNameCandidates.bind(internals);
    vi.spyOn(internals, 'findLocalContextGraphNameCandidates').mockImplementation(async (...args: unknown[]) => {
      const candidates = await findLocal(...args);
      // The placeholder moves to another on-chain slot while its candidate is read.
      internals.subscribedContextGraphs.set(NAME_HASH, {
        ...internals.subscribedContextGraphs.get(NAME_HASH),
        onChainId: '34',
      });
      return candidates;
    });
    const adopt = vi.spyOn(internals, 'adoptVerifiedContextGraphCleartext');
    const warn = vi.spyOn(internals.log, 'warn');
    startNameResolver(internals);

    await expect(internals.resolveContextGraphNameHashNow(NAME_HASH)).resolves.toBeNull();
    expect(adopt).toHaveBeenCalledTimes(1);
    await expect(adopt.mock.results[0]!.value).resolves.toBe(false);
    // Neither declined nor pending for on-chain 33: the next pass sees the
    // row as it is now (bound to 34), and nothing retries the stale target.
    const status = internals.getContextGraphNameResolutionStatus() as Array<{ state: string; onChainId: string }>;
    expect(status.filter((entry) => entry.state === 'declined' || entry.onChainId === ON_CHAIN_ID)).toEqual([]);
    expect(warn.mock.calls.filter(([, message]) => String(message).includes('Not adopting'))).toEqual([]);
    expect(internals.subscribedContextGraphs.get(NAME_HASH)).toMatchObject({ onChainId: '34', subscribed: true });
  });
});

describe('restart with a saved name-hash subscription', () => {
  const hashRow: ContextGraphSubscriptionRecord = {
    id: NAME_HASH,
    subscribed: true,
    synced: false,
    onChainId: ON_CHAIN_ID,
    onChainHash: NAME_HASH,
    syncScoped: true,
  };
  const cleartextRow: ContextGraphSubscriptionRecord = {
    id: CLEARTEXT,
    subscribed: true,
    synced: false,
    onChainId: ON_CHAIN_ID,
    onChainHash: NAME_HASH,
    syncScoped: true,
  };

  it('drops a superseded hash row and keeps syncing the cleartext id', async () => {
    const store = recordingStore([hashRow, cleartextRow]);
    const internals = await boot({ store, syncContextGraphs: [NAME_HASH] });
    await internals.rehydrateContextGraphSubscriptions(null);

    expect(store.deleted).toContain(NAME_HASH);
    expect(internals.subscribedContextGraphs.has(NAME_HASH)).toBe(false);
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ subscribed: true, onChainHash: NAME_HASH });
    expect(internals.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
    // config.contextGraphs still lists the hash; the sync scope resolves it.
    expect(internals.config.syncContextGraphs).toEqual([CLEARTEXT]);
  });

  it('keeps syncing the cleartext id when the superseded hash row cannot be dropped', async () => {
    const store = recordingStore([hashRow, cleartextRow]);
    store.delete = async () => { throw new Error('disk full'); };
    const internals = await boot({ store, syncContextGraphs: [NAME_HASH] });
    const warn = vi.spyOn(internals.log, 'warn');
    await internals.rehydrateContextGraphSubscriptions(null);

    expect(warn.mock.calls.some(([, message]) =>
      String(message).includes('Failed to drop superseded name-hash subscription row')
      && String(message).includes('disk full'))).toBe(true);
    // The next start tries again; this one still runs one identity only.
    expect(internals.subscribedContextGraphs.has(NAME_HASH)).toBe(false);
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ subscribed: true, onChainHash: NAME_HASH });
    expect(internals.config.syncContextGraphs).toEqual([CLEARTEXT]);
  });

  it('still resolves the saved hash when rehydration is switched off, without touching durable state', async () => {
    const store = recordingStore([hashRow, cleartextRow]);
    const internals = await boot({ store, syncContextGraphs: [NAME_HASH], rehydrationEnabled: false });
    await internals.rehydrateContextGraphSubscriptions(null);

    expect(internals.subscribedContextGraphs.has(CLEARTEXT)).toBe(false);
    expect(internals.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
    expect(internals.config.syncContextGraphs).toEqual([CLEARTEXT]);
    // The kill-switch leaves every persisted row exactly as it was.
    expect(store.deleted).toEqual([]);
    expect(store.saved).toEqual([]);
  });

  it('never treats a hash-shaped cleartext row as a placeholder', () => {
    const hashShapedCleartext = `0x${'ab'.repeat(32)}`;
    const rows = [
      { id: hashShapedCleartext, onChainHash: ethers.keccak256(ethers.toUtf8Bytes(hashShapedCleartext)) },
      { id: NAME_HASH, onChainHash: NAME_HASH },
    ];
    // No row is the preimage of NAME_HASH, so the placeholder stays active.
    expect(partitionSupersededContextGraphNamePlaceholders(rows).superseded).toEqual([]);
    expect(partitionSupersededContextGraphNamePlaceholders([...rows, cleartextRow]).superseded)
      .toEqual([rows[1]]);
  });
});

describe('operator-facing identity', () => {
  it('says plainly what a hash-only subscription is waiting for', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    const note = internals.describeContextGraphIdentity(NAME_HASH);
    expect(note).toMatchObject({ state: 'name-hash-only', nameHash: NAME_HASH, onChainId: ON_CHAIN_ID });
    expect(note.message).toBe(contextGraphNameHashOnlyMessage(NAME_HASH));
    expect(note.message).toContain('known only by its on-chain name hash');
    expect(note.message).toContain('waiting for a peer to reveal the cleartext id, or subscribe with the cleartext id');
    expect(note.message).not.toContain('Retry once the network is healthier');
    expect(internals.describeContextGraphIdentity(CLEARTEXT)).toBeNull();
  });

  it('distinguishes a private graph that peers will never reveal', async () => {
    const internals = await boot({ accessPolicy: 1 });
    expect(internals.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, ON_CHAIN_ID)).toBe(NAME_HASH);
    internals.onChainAccessPolicyCache.set(ON_CHAIN_ID, 1);
    internals.subscribeToContextGraph(NAME_HASH);
    const note = internals.describeContextGraphIdentity(NAME_HASH);
    expect(note).toMatchObject({ state: 'name-hash-only-private' });
    expect(note.message).toContain('Ask its curator');
  });

  it('reports the resolution once adopted', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    await internals.adoptVerifiedContextGraphCleartext(
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
      CLEARTEXT,
      'peer-protocol',
    );
    expect(internals.describeContextGraphIdentity(NAME_HASH)).toMatchObject({
      state: 'resolved',
      contextGraphId: CLEARTEXT,
    });
  });

  it('lists only hash-only rows that want a cleartext id', async () => {
    const internals = await boot();
    expect(internals.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, ON_CHAIN_ID)).toBe(NAME_HASH);
    // A discovered but unsubscribed placeholder is not a target.
    expect(internals.contextGraphNameResolutionTargets()).toEqual([]);
    internals.subscribeToContextGraph(NAME_HASH);
    expect(internals.contextGraphNameResolutionTargets()).toEqual([
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
    ]);
  });
});

/**
 * Base-mainnet canary, Context Graph #34 (2026-09-23): work that captured the
 * hash id before adoption kept running afterwards. Its identity checks
 * re-hashed the hash as if it were cleartext ("local mapping is STALE",
 * "name-bound elsewhere") and a reconcile pass ended as "queue is closed for
 * node shutdown". Each case below is such a straggler.
 */
describe('retiring the hash id after adoption (Base #34 canary)', () => {
  const target = { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID };
  const MISLEADING = [/STALE/, /node shutdown/, /name-bound elsewhere/, /not authori[sz]ed|unauthori[sz]ed/];

  function messages(spy: MockInstance): string[] {
    return spy.mock.calls.map(([, message]) => String(message));
  }

  function misleadingWarningsAbout(warn: MockInstance, id: string): string[] {
    return messages(warn).filter((message) =>
      message.includes(id) && MISLEADING.some((pattern) => pattern.test(message)));
  }

  it('answers policy reads for the retired hash as the cleartext graph, and never fails closed', async () => {
    const internals = await boot({ accessPolicy: 0 });
    subscribeByNameHash(internals);
    // The live placeholder is not superseded; its wire-keyed proof holds.
    expect(internals.supersedingContextGraphIdFor(NAME_HASH)).toBeNull();
    await expect(internals.isContextGraphPublicOnChain(NAME_HASH)).resolves.toBe(true);
    await expect(internals.requireLocalCgMatchesOnChainSlot(NAME_HASH, ON_CHAIN_ID)).resolves.toBe(true);

    await internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology');
    const warn = vi.spyOn(internals.log, 'warn');
    expect(internals.supersedingContextGraphIdFor(NAME_HASH)).toBe(CLEARTEXT);
    await expect(internals.isContextGraphPublicOnChain(CLEARTEXT)).resolves.toBe(true);
    await expect(internals.isContextGraphPublicOnChain(NAME_HASH)).resolves.toBe(true);
    await expect(internals.resolveOnChainAccessPolicyState(NAME_HASH)).resolves.toBe(0);
    await expect(internals.resolveFinalizedOnChainAccessPolicyState(NAME_HASH)).resolves.toBe(0);
    expect(misleadingWarningsAbout(warn, NAME_HASH)).toEqual([]);
  });

  it('stops sync keyed by the retired hash instead of writing under it', async () => {
    const internals = await boot({ accessPolicy: 0 });
    subscribeByNameHash(internals);
    await internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology');
    const warn = vi.spyOn(internals.log, 'warn');
    // The durable-sync and exact-fetch identity proof gates writes: it must
    // neither pass (data would land under the retired id) nor blame a stale
    // mapping or the peer's asset.
    const proof = internals.requireLocalCgMatchesOnChainSlot(NAME_HASH, ON_CHAIN_ID);
    await expect(proof).rejects.toBeInstanceOf(SyncTargetSupersededError);
    await expect(proof).rejects.toMatchObject({
      name: 'AbortError',
      contextGraphId: NAME_HASH,
      supersededBy: CLEARTEXT,
    });
    // The cleartext id proves the same slot.
    await expect(internals.requireLocalCgMatchesOnChainSlot(CLEARTEXT, ON_CHAIN_ID)).resolves.toBe(true);
    expect(misleadingWarningsAbout(warn, NAME_HASH)).toEqual([]);
  });

  it('reports an RFC-64 authority refresh for the retired hash as superseded', async () => {
    const internals = await boot({ accessPolicy: 0 });
    subscribeByNameHash(internals);
    // The refresh a scheduler batched for the hash before adoption: finalized
    // evidence for slot 33, whose committed name is the hash itself.
    const snapshot = await internals.chain.getContextGraphAuthoritySnapshot(BigInt(ON_CHAIN_ID));
    expect(snapshot.nameHash).toBe(NAME_HASH);
    const request = {
      kind: 'finalized-evidence',
      evidence: { contextGraphAuthorityIndexId: ON_CHAIN_ID, batchTargetIds: [ON_CHAIN_ID], snapshot },
    };
    // A running catalog service on a trusted network, so the refresh reaches
    // the name check the canary failed.
    vi.spyOn(internals, 'rfc64PublicCatalogServiceV1', 'get').mockReturnValue({});
    internals.config.networkIdentity = { ...internals.config.networkIdentity, chainId: 'mock:31337' };

    await internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology');
    await expect(internals.reconcileRfc64CatalogAccessAuthorityV1(NAME_HASH, undefined, request))
      .resolves.toBeNull();
  });

  it('ends a VM reconcile in flight for the hash quietly, and reconciles the cleartext id', async () => {
    const internals = await boot({ accessPolicy: 0 });
    subscribeByNameHash(internals);
    const scheduling = internals.ensureVmReconcileScheduling();
    const triggered = vi.spyOn(scheduling, 'triggerLive');
    const warn = vi.spyOn(internals.log, 'warn');
    const debug = vi.spyOn(internals.log, 'debug');
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolveTarget = internals.resolveVmReconcileTarget.bind(internals);
    vi.spyOn(internals, 'resolveVmReconcileTarget').mockImplementation(async (...args: unknown[]) => {
      // Resolve the pass's target while the placeholder is live, as on the
      // canary, then hold the pass there until adoption has landed.
      const resolved = await resolveTarget(...args);
      if (args[0] === NAME_HASH) {
        entered = true;
        await gate;
      }
      return resolved;
    });

    // The pass the hash subscription started is in flight when adoption lands.
    scheduling.triggerLive(NAME_HASH);
    await waitFor(() => entered);
    await internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology');
    release();
    await scheduling.waitForIdle(NAME_HASH);

    expect(messages(warn).filter((message) => message.includes(NAME_HASH))).toEqual([]);
    expect(messages(debug)).toContain(
      `VM reconcile for "${NAME_HASH}" stopped: superseded by cleartext adoption of "${CLEARTEXT}"`,
    );
    // Work continues under the cleartext id.
    await waitFor(() => triggered.mock.calls.some(([id]) => id === CLEARTEXT));
  });

  it('drops a reconcile queued for the hash before adoption without resolving a target', async () => {
    const internals = await boot({ accessPolicy: 0 });
    subscribeByNameHash(internals);
    const scheduling = internals.ensureVmReconcileScheduling();
    await internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology');
    const warn = vi.spyOn(internals.log, 'warn');
    const debug = vi.spyOn(internals.log, 'debug');
    const resolveTarget = vi.spyOn(internals, 'resolveVmReconcileTarget');

    scheduling.triggerLive(NAME_HASH);
    await scheduling.waitForIdle(NAME_HASH);

    expect(resolveTarget.mock.calls.filter(([id]) => id === NAME_HASH)).toEqual([]);
    expect(messages(warn).filter((message) => message.includes(NAME_HASH))).toEqual([]);
    expect(messages(debug)).toContain(
      `VM reconcile for "${NAME_HASH}" stopped: superseded by cleartext adoption of "${CLEARTEXT}"`,
    );
  });

  it('skips SWM work queued for the hash, before any authorization check', async () => {
    const internals = await boot({ accessPolicy: 0 });
    subscribeByNameHash(internals);
    await internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology');
    const warn = vi.spyOn(internals.log, 'warn');
    const authorize = vi.spyOn(internals, 'canUseSharedMemoryForContextGraph');

    const plan = await internals.planSharedMemorySyncContextGraphs(
      undefined,
      [NAME_HASH],
      createOperationContext('sync'),
    );
    expect(plan.targets.map(({ contextGraphId }: { contextGraphId: string }) => contextGraphId)).toEqual([]);
    await internals.reconcileSharedMemoryGossipSubscription(NAME_HASH);

    expect(authorize.mock.calls.filter(([id]) => id === NAME_HASH)).toEqual([]);
    expect(internals.sharedMemoryGossipRegistered.has(NAME_HASH)).toBe(false);
    expect(misleadingWarningsAbout(warn, NAME_HASH)).toEqual([]);
  });

  it('logs the retirement of the hash subscription with its reason', async () => {
    const internals = await boot({ accessPolicy: 0 });
    subscribeByNameHash(internals);
    const info = vi.spyOn(internals.log, 'info');
    await internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-ontology');
    expect(messages(info)).toContain(
      `Retired name-hash subscription "${NAME_HASH}": superseded by cleartext adoption of "${CLEARTEXT}"`,
    );
    expect(messages(info).filter((message) => message.startsWith(`Unsubscribed from "${NAME_HASH}"`))).toEqual([]);
  });

  it('keeps a private graph private under its retired hash', async () => {
    const internals = await boot({ accessPolicy: 1 });
    expect(internals.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, ON_CHAIN_ID)).toBe(NAME_HASH);
    internals.onChainAccessPolicyCache.set(ON_CHAIN_ID, 1);
    internals.subscribeToContextGraph(NAME_HASH);
    // A curator's cleartext id, adopted without any peer revealing it.
    await internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'local-store');
    expect(internals.supersedingContextGraphIdFor(NAME_HASH)).toBe(CLEARTEXT);
    await expect(internals.isContextGraphPublicOnChain(NAME_HASH)).resolves.toBe(false);
    await expect(internals.isContextGraphPublicOnChain(CLEARTEXT)).resolves.toBe(false);
  });

  it('keeps every fail-closed path for hashes it has not adopted', async () => {
    const internals = await boot({ accessPolicy: 0 });
    const warn = vi.spyOn(internals.log, 'warn');
    // Unknown hash: nothing supersedes it and it is not public.
    const unknownHash = ethers.keccak256(ethers.toUtf8Bytes('someone-elses-graph')).toLowerCase();
    expect(internals.supersedingContextGraphIdFor(unknownHash)).toBeNull();
    await expect(internals.isContextGraphPublicOnChain(unknownHash)).resolves.toBe(false);

    // A genuinely stale mapping: a wire-keyed row bound to a slot that commits
    // another name still fails closed, with its diagnostic.
    const staleHash = ethers.keccak256(ethers.toUtf8Bytes('reused-slot')).toLowerCase();
    internals.setContextGraphSubscription(staleHash, {
      subscribed: false,
      synced: false,
      onChainId: ON_CHAIN_ID,
      onChainHash: staleHash,
    });
    expect(internals.supersedingContextGraphIdFor(staleHash)).toBeNull();
    await expect(internals.isContextGraphPublicOnChain(staleHash)).resolves.toBe(false);
    expect(messages(warn).some((message) => message.includes(staleHash) && message.includes('STALE'))).toBe(true);

    // A hash-shaped cleartext id is its own graph.
    const hashShaped = `0x${'cd'.repeat(32)}`;
    internals.setContextGraphSubscription(hashShaped, { subscribed: false, synced: false });
    expect(internals.supersedingContextGraphIdFor(hashShaped)).toBeNull();

    // A graph only ever known by cleartext indexes its own hash, but no hash
    // row was retired for it: nothing is superseded.
    internals.setContextGraphSubscription('acme-plain', { subscribed: false, synced: false, onChainId: '7' });
    const plainHash = ethers.keccak256(ethers.toUtf8Bytes('acme-plain')).toLowerCase();
    expect(internals.wireIdToLocalCgId.get(plainHash)).toBe('acme-plain');
    expect(internals.supersedingContextGraphIdFor(plainHash)).toBeNull();

    // A cleartext row that carries the hash but is not bound on-chain proves
    // no slot: it stays an alias for subscribe, never a policy answer.
    internals.setContextGraphSubscription(CLEARTEXT, { subscribed: false, synced: false, onChainHash: NAME_HASH });
    expect(internals.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
    expect(internals.supersedingContextGraphIdFor(NAME_HASH)).toBeNull();
  });
});

describe('name responder on the agent', () => {
  it('reveals only a cleartext row, never a placeholder', async () => {
    const internals = await boot();
    subscribeByNameHash(internals);
    expect(internals.lookupLocalContextGraphIdForNameHash(NAME_HASH)).toBeNull();
    await internals.adoptVerifiedContextGraphCleartext(
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
      CLEARTEXT,
      'peer-protocol',
    );
    expect(internals.lookupLocalContextGraphIdForNameHash(NAME_HASH)).toBe(CLEARTEXT);
  });

  it('proves public policy from its own authority state and refuses private graphs', async () => {
    const publicAgent = await boot({ accessPolicy: 0 });
    publicAgent.subscribeToContextGraph(CLEARTEXT, { onChainId: ON_CHAIN_ID });
    await expect(publicAgent.isContextGraphPublicForNameReveal(CLEARTEXT, new AbortController().signal))
      .resolves.toBe(true);
    await agent!.stop();

    const privateAgent = await boot({ accessPolicy: 1 });
    privateAgent.subscribeToContextGraph(CLEARTEXT, { onChainId: ON_CHAIN_ID });
    await expect(privateAgent.isContextGraphPublicForNameReveal(CLEARTEXT, new AbortController().signal))
      .resolves.toBe(false);
    // Unknown graphs fail closed as well.
    await expect(privateAgent.isContextGraphPublicForNameReveal('never-seen', new AbortController().signal))
      .resolves.toBe(false);
  });

  it('fails closed when the chain proof itself errors', async () => {
    const internals = await boot({ accessPolicy: 0 });
    internals.subscribeToContextGraph(CLEARTEXT, { onChainId: ON_CHAIN_ID });
    vi.spyOn(internals, 'isContextGraphPublicOnChain').mockRejectedValue(new Error('rpc unavailable'));
    await expect(internals.isContextGraphPublicForNameReveal(CLEARTEXT, new AbortController().signal))
      .resolves.toBe(false);
  });

  it('proves a public graph once, then answers from memory', async () => {
    const internals = await boot({ accessPolicy: 0 });
    internals.subscribeToContextGraph(CLEARTEXT, { onChainId: ON_CHAIN_ID });
    const proof = vi.spyOn(internals, 'isContextGraphPublicOnChain');
    for (let request = 0; request < 3; request += 1) {
      await expect(internals.isContextGraphPublicForNameReveal(CLEARTEXT, new AbortController().signal))
        .resolves.toBe(true);
    }
    expect(proof).toHaveBeenCalledTimes(1);
  });

  it('remembers a bounded number of verdicts, forgetting the oldest first', async () => {
    const internals = await boot();
    const proof = vi.spyOn(internals, 'isContextGraphPublicOnChain').mockResolvedValue(false);
    const ids = Array.from({ length: 4_097 }, (_, index) => `acme-graph-${index}`);
    for (const id of ids) internals.subscribedContextGraphs.set(id, { subscribed: false, synced: false });
    try {
      for (const id of ids) await internals.isContextGraphPublicForNameReveal(id, new AbortController().signal);
      expect(proof).toHaveBeenCalledTimes(4_097);
      // A recent refusal is answered from memory; the oldest was evicted.
      await internals.isContextGraphPublicForNameReveal(ids[4_096], new AbortController().signal);
      expect(proof).toHaveBeenCalledTimes(4_097);
      await internals.isContextGraphPublicForNameReveal(ids[0], new AbortController().signal);
      expect(proof).toHaveBeenCalledTimes(4_098);
    } finally {
      for (const id of ids) internals.subscribedContextGraphs.delete(id);
    }
  });

  it('refuses when the bound public slot does not commit this id', async () => {
    // A stale local binding (a chain reset, a reused slot) points at a public
    // slot that commits no name, or another name. That proves nothing about
    // this id, whose own graph may well be private.
    for (const committedNameHash of [null, ethers.keccak256(ethers.toUtf8Bytes('someone-else')).toLowerCase()]) {
      const internals = await boot({ accessPolicy: 0, committedNameHash });
      internals.subscribeToContextGraph(CLEARTEXT, { onChainId: ON_CHAIN_ID });
      await expect(internals.isContextGraphPublicForNameReveal(CLEARTEXT, new AbortController().signal))
        .resolves.toBe(false);
      expect(internals.lookupLocalContextGraphIdForNameHash(NAME_HASH)).toBe(CLEARTEXT);
      await agent!.stop();
      agent = null;
    }
  });
});

describe('resolver dependencies on the agent', () => {
  const target = { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID };
  const live = () => new AbortController().signal;
  // The vocabulary nodes write, not a copy of the code under test.
  const RDF_TYPE = DKG_ONTOLOGY.RDF_TYPE;
  const CONTEXT_GRAPH_TYPE = DKG_ONTOLOGY.DKG_CONTEXT_GRAPH;
  const ON_CHAIN_ID_PREDICATE = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
  const SERVED_PREDICATE = 'https://dkg.origintrail.io/skill#contextGraphsServed';
  const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const PEER = '12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA';

  it('reads the fixed access policy from the chain when it is not cached, then caches it', async () => {
    const publicAgent = await boot({ accessPolicy: 0 });
    expect(publicAgent.onChainAccessPolicyCache.has(ON_CHAIN_ID)).toBe(false);
    await expect(publicAgent.classifyContextGraphNamePolicy(target, live())).resolves.toBe('public');
    expect(publicAgent.onChainAccessPolicyCache.get(ON_CHAIN_ID)).toBe(0);
    await agent!.stop();
    agent = null;

    const privateAgent = await boot({ accessPolicy: 1 });
    await expect(privateAgent.classifyContextGraphNamePolicy(target, live())).resolves.toBe('private');
    privateAgent.chain.getContextGraphAccessPolicy = async () => { throw new Error('must not be read again'); };
    await expect(privateAgent.classifyContextGraphNamePolicy(target, live())).resolves.toBe('private');
  });

  it('fails closed on an unreadable or unexpected access policy', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => { throw new Error('rpc timeout'); };
    await expect(internals.classifyContextGraphNamePolicy(target, live())).resolves.toBe('unknown');
    internals.chain.getContextGraphAccessPolicy = async () => 2;
    await expect(internals.classifyContextGraphNamePolicy(target, live())).resolves.toBe('unknown');
    internals.chain.getContextGraphAccessPolicy = undefined;
    await expect(internals.classifyContextGraphNamePolicy(target, live())).resolves.toBe('unknown');
    expect(internals.onChainAccessPolicyCache.has(ON_CHAIN_ID)).toBe(false);
  });

  it('finds the cleartext id in its own ontology graph, by on-chain id first', async () => {
    const internals = await boot();
    await internals.store.insert([
      // Another graph's definition is read and discarded.
      { graph: ONTOLOGY_GRAPH, subject: 'did:dkg:context-graph:acme-other', predicate: RDF_TYPE, object: CONTEXT_GRAPH_TYPE },
      { graph: ONTOLOGY_GRAPH, subject: `did:dkg:context-graph:${CLEARTEXT}`, predicate: ON_CHAIN_ID_PREDICATE, object: '"33"' },
    ]);
    await expect(internals.findLocalContextGraphNameCandidates(target, live())).resolves.toEqual([CLEARTEXT]);
  });

  it('finds the cleartext id that a gossiped agent profile serves', async () => {
    const internals = await boot();
    await internals.store.insert([{
      graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS),
      subject: `did:dkg:agent:${PEER}`,
      predicate: SERVED_PREDICATE,
      object: `"${CLEARTEXT}"`,
    }]);
    await expect(internals.findLocalContextGraphNameCandidates(target, live())).resolves.toEqual([CLEARTEXT]);
  });

  it('finds nothing when no local row matches the hash, and survives a failing query', async () => {
    const internals = await boot();
    await internals.store.insert([
      { graph: ONTOLOGY_GRAPH, subject: 'did:dkg:context-graph:acme-other', predicate: RDF_TYPE, object: CONTEXT_GRAPH_TYPE },
    ]);
    await expect(internals.findLocalContextGraphNameCandidates(target, live())).resolves.toEqual([]);

    await internals.store.insert([
      { graph: ONTOLOGY_GRAPH, subject: `did:dkg:context-graph:${CLEARTEXT}`, predicate: RDF_TYPE, object: CONTEXT_GRAPH_TYPE },
    ]);
    const query = vi.spyOn(internals.store, 'query').mockRejectedValueOnce(new Error('query budget exhausted'));
    await expect(internals.findLocalContextGraphNameCandidates(target, live())).resolves.toEqual([CLEARTEXT]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reads protocol support from the identify record, and knows nothing about unknown peers', async () => {
    const internals = await boot();
    const records = new Map<string, string[]>([[PEER, [PROTOCOL_CONTEXT_GRAPH_NAME]]]);
    internals.node.libp2p.peerStore = {
      get: async (peerId: { toString(): string }) => {
        const protocols = records.get(peerId.toString());
        if (protocols === undefined) throw new Error('Not Found');
        return { protocols };
      },
    };
    await expect(internals.peerAdvertisesProtocol(PEER, PROTOCOL_CONTEXT_GRAPH_NAME)).resolves.toBe(true);
    await expect(internals.peerAdvertisesProtocol(PEER, '/dkg/10.0.0/sync')).resolves.toBe(false);
    records.set(PEER, []); // identify still pending
    await expect(internals.peerAdvertisesProtocol(PEER, PROTOCOL_CONTEXT_GRAPH_NAME)).resolves.toBeUndefined();
    records.delete(PEER);
    await expect(internals.peerAdvertisesProtocol(PEER, PROTOCOL_CONTEXT_GRAPH_NAME)).resolves.toBeUndefined();
  });

  it('never pulls the ontology of a peer that network admission refuses', async () => {
    const internals = await boot();
    internals.peerAdvertisesProtocol = async () => true;
    internals.ensurePeerAdmittedForRecovery = async () => false;
    const fetch = vi.spyOn(internals, 'fetchSyncPages');
    await expect(internals.pullPeerOntologyForContextGraphNames(PEER, [NAME_HASH], live())).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('scans a pulled ontology in memory; an incomplete scan that found nothing proves nothing', async () => {
    const internals = await boot();
    internals.peerAdvertisesProtocol = async () => true;
    internals.ensurePeerAdmittedForRecovery = async () => true;
    const definition = {
      graph: ONTOLOGY_GRAPH,
      subject: `did:dkg:context-graph:${CLEARTEXT}`,
      predicate: RDF_TYPE,
      object: CONTEXT_GRAPH_TYPE,
    };
    internals.fetchSyncPages = async () => ({ quads: [definition], completed: false });
    await expect(internals.pullPeerOntologyForContextGraphNames(PEER, [NAME_HASH], live()))
      .resolves.toEqual(new Map([[NAME_HASH, CLEARTEXT]]));
    internals.fetchSyncPages = async () => ({ quads: [], completed: false });
    await expect(internals.pullPeerOntologyForContextGraphNames(PEER, [NAME_HASH], live())).resolves.toBeNull();
    internals.fetchSyncPages = async () => ({ quads: [], completed: true });
    await expect(internals.pullPeerOntologyForContextGraphNames(PEER, [NAME_HASH], live())).resolves.toEqual(new Map());
  });

  it('treats a failed ontology pull as no answer, unless the resolver is stopping', async () => {
    const internals = await boot();
    internals.peerAdvertisesProtocol = async () => true;
    internals.ensurePeerAdmittedForRecovery = async () => true;
    internals.fetchSyncPages = async () => { throw new Error('stream reset'); };
    await expect(internals.pullPeerOntologyForContextGraphNames(PEER, [NAME_HASH], live())).resolves.toBeNull();
    await expect(internals.pullPeerOntologyForContextGraphNames(PEER, [NAME_HASH], AbortSignal.abort()))
      .rejects.toThrow('stream reset');
  });
});
