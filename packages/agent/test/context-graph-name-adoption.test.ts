/**
 * Adoption of a verified cleartext id for a Context Graph this node knows only
 * by its on-chain name hash (Base-mainnet Context Graph #33, 2026-09-23), and
 * the restart contract for a `--save`d hash subscription.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import type {
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
} from '../src/dkg-agent-types.js';
import { DKGAgent } from '../src/index.js';
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('adopting a verified cleartext id', () => {
  it('promotes a durable hash subscription to the cleartext id everywhere', async () => {
    const store = recordingStore();
    const internals = await boot({ store });
    subscribeByNameHash(internals);
    await flush();
    expect(store.saved.map((row) => row.id)).toContain(NAME_HASH);
    expect(internals.config.syncContextGraphs).toContain(NAME_HASH);

    const target = { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID };
    await expect(internals.adoptVerifiedContextGraphCleartext(target, CLEARTEXT, 'peer-protocol'))
      .resolves.toBe(true);
    await flush();

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
    await expect(internals.adoptVerifiedContextGraphCleartext(
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
      CLEARTEXT,
      'peer-protocol',
    )).resolves.toBe(false);
    expect(internals.subscribedContextGraphs.get(NAME_HASH)).toMatchObject({ onChainId: ON_CHAIN_ID });
    expect(internals.subscribedContextGraphs.get(CLEARTEXT)).toMatchObject({ onChainId: '99' });
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
    await flush();
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
