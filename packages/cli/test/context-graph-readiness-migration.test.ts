import { describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  migrateLegacyContextGraphReadiness,
  persistProjectSyncedReadiness,
  type ContextGraphReadinessStore,
} from '../src/context-graph-readiness.js';

type Subscription = {
  subscribed?: boolean;
  synced?: boolean;
  sharedMemorySynced?: boolean;
  metaSynced?: boolean;
  pendingMeta?: boolean;
};

function fixture(options: {
  contextGraphId?: string;
  subscription?: Subscription;
  curated?: boolean;
  confirmedMeta?: boolean;
  privateGraph?: boolean;
  chainAccessPolicy?: number;
}) {
  const contextGraphId = options.contextGraphId ?? 'migration/private-cg';
  const subscriptions = new Map<string, Subscription>([[
    contextGraphId,
    options.subscription ?? {
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
    },
  ]]);
  let provenance: {
    version: number;
    durableVerified: boolean;
    sharedMemoryVerified: boolean;
    updatedAt: number;
  } | null = null;
  const markContextGraphSubscriptionState = vi.fn(
    (id: string, patch: Partial<Subscription>) => {
      subscriptions.set(id, { ...subscriptions.get(id), ...patch });
    },
  );
  const store: ContextGraphReadinessStore = {
    getContextGraphReadinessProvenance: () => provenance,
    setContextGraphReadinessProvenance: (_id, next) => {
      provenance = { ...next, updatedAt: next.updatedAt ?? Date.now() };
    },
  };
  const agent = {
    getSubscribedContextGraphs: () => subscriptions,
    markContextGraphSubscriptionState,
    isCuratorOf: async () => options.curated ?? false,
    hasConfirmedMetaState: async () => options.confirmedMeta ?? false,
    isPrivateContextGraph: async () => options.privateGraph ?? true,
    getContextGraphOnChainPolicy: async () => ({ accessPolicy: options.chainAccessPolicy }),
  } as unknown as DKGAgent;

  return {
    agent,
    contextGraphId,
    subscriptions,
    store,
    markContextGraphSubscriptionState,
    getProvenance: () => provenance,
  };
}

describe('legacy context-graph readiness provenance migration', () => {
  it('resets an unproven private row once and preserves newly verified provenance on restart', async () => {
    const f = fixture({
      confirmedMeta: true,
      privateGraph: true,
      chainAccessPolicy: 1,
    });

    await migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log: vi.fn(),
    });

    expect(f.subscriptions.get(f.contextGraphId)).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(f.getProvenance()).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });

    f.subscriptions.set(f.contextGraphId, {
      ...f.subscriptions.get(f.contextGraphId),
      synced: true,
      sharedMemorySynced: true,
    });
    f.store.setContextGraphReadinessProvenance(f.contextGraphId, {
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
    });
    f.markContextGraphSubscriptionState.mockClear();

    await migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log: vi.fn(),
    });

    expect(f.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(f.subscriptions.get(f.contextGraphId)).toMatchObject({
      synced: true,
      sharedMemorySynced: true,
    });
    expect(f.getProvenance()).toMatchObject({
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });

  it('seeds provenance from persisted flags for a locally curated private graph', async () => {
    const f = fixture({ curated: true, privateGraph: true, chainAccessPolicy: 1 });

    await migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log: vi.fn(),
    });

    expect(f.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(f.getProvenance()).toMatchObject({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });

  it('fails closed for a remote join-approved private row with legacy true flags', async () => {
    const f = fixture({ confirmedMeta: true, privateGraph: true, chainAccessPolicy: 1 });

    await migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log: vi.fn(),
    });

    expect(f.subscriptions.get(f.contextGraphId)).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(f.getProvenance()).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('fails closed for an unconfirmed remote public shadow with legacy true flags', async () => {
    const f = fixture({ confirmedMeta: false, privateGraph: false, chainAccessPolicy: 0 });

    await migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log: vi.fn(),
    });

    expect(f.subscriptions.get(f.contextGraphId)).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(f.getProvenance()).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('preserves a confirmed public row without relying on a creator triple', async () => {
    const f = fixture({
      confirmedMeta: true,
      privateGraph: false,
      chainAccessPolicy: 0,
    });

    await migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log: vi.fn(),
    });

    expect(f.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(f.getProvenance()).toMatchObject({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });
});

describe('PROJECT_SYNCED readiness provenance', () => {
  it('persists inserted durable data only after metadata is confirmed', async () => {
    const f = fixture({ confirmedMeta: true });

    await expect(persistProjectSyncedReadiness({
      agent: f.agent,
      store: f.store,
      contextGraphId: f.contextGraphId,
      dataSynced: 7,
      sharedMemorySynced: 0,
    })).resolves.toBe(true);

    expect(f.getProvenance()).toMatchObject({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: false,
    });
  });

  it('preserves current proof for the other data plane', async () => {
    const f = fixture({ confirmedMeta: true });
    f.store.setContextGraphReadinessProvenance(f.contextGraphId, {
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: false,
    });

    await persistProjectSyncedReadiness({
      agent: f.agent,
      store: f.store,
      contextGraphId: f.contextGraphId,
      dataSynced: 0,
      sharedMemorySynced: 4,
    });

    expect(f.getProvenance()).toMatchObject({
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });

  it('persists verified private-only durable proof across restart migration', async () => {
    const f = fixture({ confirmedMeta: true, privateGraph: true, chainAccessPolicy: 1 });

    await expect(persistProjectSyncedReadiness({
      agent: f.agent,
      store: f.store,
      contextGraphId: f.contextGraphId,
      dataSynced: 0,
      sharedMemorySynced: 0,
      verifiedPrivateOnlyResponses: 1,
    })).resolves.toBe(true);

    expect(f.getProvenance()).toMatchObject({
      durableVerified: true,
      sharedMemoryVerified: false,
    });

    f.markContextGraphSubscriptionState.mockClear();
    await migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log: vi.fn(),
    });

    expect(f.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(f.subscriptions.get(f.contextGraphId)).toMatchObject({ synced: true });
    expect(f.getProvenance()).toMatchObject({ durableVerified: true });
  });

  it('does not persist an unconfirmed or empty PROJECT_SYNCED event', async () => {
    const unconfirmed = fixture({ confirmedMeta: false });

    await expect(persistProjectSyncedReadiness({
      agent: unconfirmed.agent,
      store: unconfirmed.store,
      contextGraphId: unconfirmed.contextGraphId,
      dataSynced: 3,
      sharedMemorySynced: 0,
    })).resolves.toBe(false);
    expect(unconfirmed.getProvenance()).toBeNull();

    const empty = fixture({ confirmedMeta: true });
    await expect(persistProjectSyncedReadiness({
      agent: empty.agent,
      store: empty.store,
      contextGraphId: empty.contextGraphId,
      dataSynced: 0,
      sharedMemorySynced: 0,
    })).resolves.toBe(false);
    expect(empty.getProvenance()).toBeNull();
  });
});
