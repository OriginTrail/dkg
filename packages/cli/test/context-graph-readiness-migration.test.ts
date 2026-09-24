import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  migrateLegacyContextGraphReadiness,
  parseProjectSyncedReadinessPayload,
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
  it('normalizes a legacy PROJECT_SYNCED payload without private-only evidence', () => {
    expect(parseProjectSyncedReadinessPayload({
      contextGraphId: 'legacy-project-synced',
      dataSynced: 2,
      sharedMemorySynced: 0,
    })).toEqual({
      contextGraphId: 'legacy-project-synced',
      dataSynced: 2,
      sharedMemorySynced: 0,
      verifiedPrivateOnlyResponses: 0,
    });
  });

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

type Row = Subscription & { coreHosted?: boolean };
type Provenance = {
  version: number;
  durableVerified: boolean;
  sharedMemoryVerified: boolean;
  updatedAt: number;
};
type ConfirmOptions = { signal?: AbortSignal };

/** A live subscription map shared by several rows, with per-call lookup spies. */
function multiRowFixture(
  rows: Record<string, Row>,
  lookups: {
    isCuratorOf?: (id: string, options: ConfirmOptions) => Promise<boolean>;
    hasConfirmedMetaState?: (id: string, options: ConfirmOptions) => Promise<boolean>;
    isPrivateContextGraph?: (id: string, options: ConfirmOptions) => Promise<boolean>;
    getContextGraphOnChainPolicy?: (
      id: string,
      options: ConfirmOptions,
    ) => Promise<{ accessPolicy?: number }>;
  } = {},
) {
  const subscriptions = new Map<string, Row>(Object.entries(rows));
  const provenance = new Map<string, Provenance>();
  const store: ContextGraphReadinessStore = {
    getContextGraphReadinessProvenance: (id) => provenance.get(id) ?? null,
    setContextGraphReadinessProvenance: (id, next) => {
      provenance.set(id, { ...next, updatedAt: next.updatedAt ?? Date.now() });
    },
  };
  const markContextGraphSubscriptionState = vi.fn((id: string, patch: Partial<Row>) => {
    const existing = subscriptions.get(id);
    if (existing) subscriptions.set(id, { ...existing, ...patch });
  });
  const isCuratorOf = vi.fn(lookups.isCuratorOf ?? (async () => false));
  const hasConfirmedMetaState = vi.fn(lookups.hasConfirmedMetaState ?? (async () => false));
  const isPrivateContextGraph = vi.fn(lookups.isPrivateContextGraph ?? (async () => true));
  const getContextGraphOnChainPolicy = vi.fn(
    lookups.getContextGraphOnChainPolicy ?? (async () => ({})),
  );
  const agent = {
    getSubscribedContextGraphs: () => subscriptions,
    markContextGraphSubscriptionState,
    isCuratorOf,
    hasConfirmedMetaState,
    isPrivateContextGraph,
    getContextGraphOnChainPolicy,
  } as unknown as DKGAgent;
  return {
    agent,
    subscriptions,
    provenance,
    store,
    markContextGraphSubscriptionState,
    isCuratorOf,
    hasConfirmedMetaState,
    isPrivateContextGraph,
    getContextGraphOnChainPolicy,
  };
}

const LEGACY_SYNCED: Row = {
  subscribed: true,
  synced: true,
  sharedMemorySynced: true,
  metaSynced: true,
};

/** Never settles on its own; records the signal it was handed. */
function pendingUntilAborted(signals: AbortSignal[], answerOnAbort?: boolean) {
  return (_id: string, options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    if (options.signal) signals.push(options.signal);
    if (answerOnAbort) {
      options.signal?.addEventListener('abort', () => resolve(true), { once: true });
    }
  });
}

describe('bounded legacy readiness migration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not migrate rows that discovery adds to the live map mid-pass', async () => {
    const f = multiRowFixture({ 'mid-pass/existing': LEGACY_SYNCED }, {
      hasConfirmedMetaState: async () => {
        // Discovery adds rows while the pass awaits. An active one would be
        // migrated if the pass iterated the live map.
        f.subscriptions.set('mid-pass/discovered-active', { ...LEGACY_SYNCED, coreHosted: true });
        f.subscriptions.set('mid-pass/discovered-inactive', { subscribed: false, synced: true });
        return false;
      },
    });

    await migrateLegacyContextGraphReadiness({ agent: f.agent, store: f.store, log: vi.fn() });

    expect(f.hasConfirmedMetaState.mock.calls.map(([id]) => id)).toEqual(['mid-pass/existing']);
    expect(f.markContextGraphSubscriptionState.mock.calls.map(([id]) => id))
      .toEqual(['mid-pass/existing']);
    expect(f.provenance.has('mid-pass/discovered-active')).toBe(false);
    expect(f.provenance.has('mid-pass/discovered-inactive')).toBe(false);
  });

  it('leaves inactive catalogue rows untouched and migrates core-hosted rows', async () => {
    const f = multiRowFixture({
      'catalogue/claimed-synced': { subscribed: false, synced: true, sharedMemorySynced: true },
      'catalogue/never-synced': { subscribed: false },
      'hosted/legacy': { subscribed: false, coreHosted: true, synced: true },
    });

    await migrateLegacyContextGraphReadiness({ agent: f.agent, store: f.store, log: vi.fn() });

    for (const id of ['catalogue/claimed-synced', 'catalogue/never-synced']) {
      expect(f.provenance.has(id)).toBe(false);
      expect(f.markContextGraphSubscriptionState).not.toHaveBeenCalledWith(id, expect.anything());
      expect(f.isCuratorOf).not.toHaveBeenCalledWith(id, expect.anything());
      expect(f.hasConfirmedMetaState).not.toHaveBeenCalledWith(id, expect.anything());
    }
    expect(f.subscriptions.get('catalogue/claimed-synced'))
      .toEqual({ subscribed: false, synced: true, sharedMemorySynced: true });
    // Core hosting is active intent: the unconfirmed hosted row fails closed.
    expect(f.markContextGraphSubscriptionState).toHaveBeenCalledWith('hosted/legacy', {
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(f.provenance.get('hosted/legacy')).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('stamps rows that never claimed readiness without any lookup', async () => {
    const f = multiRowFixture({
      'never-synced/member': {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
        pendingMeta: false,
      },
      // Shared memory alone is a readiness claim and must still be confirmed.
      'swm-only/public': { subscribed: true, synced: false, sharedMemorySynced: true },
    }, {
      hasConfirmedMetaState: async () => true,
      isPrivateContextGraph: async () => false,
      getContextGraphOnChainPolicy: async () => ({ accessPolicy: 0 }),
    });

    await migrateLegacyContextGraphReadiness({ agent: f.agent, store: f.store, log: vi.fn() });

    expect(f.provenance.get('never-synced/member')).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
    expect(f.isCuratorOf).not.toHaveBeenCalledWith('never-synced/member', expect.anything());
    expect(f.hasConfirmedMetaState)
      .not.toHaveBeenCalledWith('never-synced/member', expect.anything());
    expect(f.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(f.subscriptions.get('never-synced/member')).toMatchObject({
      metaSynced: true,
      pendingMeta: false,
    });
    expect(f.hasConfirmedMetaState).toHaveBeenCalledWith('swm-only/public', expect.anything());
    expect(f.provenance.get('swm-only/public')).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: true,
    });
  });

  it('fails a never-settling confirmation closed at its deadline and moves on', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const log = vi.fn();
    const f = multiRowFixture({
      'deadline/hangs': LEGACY_SYNCED,
      'deadline/public': LEGACY_SYNCED,
    }, {
      hasConfirmedMetaState: (id, options) => (id === 'deadline/hangs'
        ? pendingUntilAborted(signals)(id, options)
        : Promise.resolve(true)),
      isPrivateContextGraph: async () => false,
      getContextGraphOnChainPolicy: async () => ({ accessPolicy: 0 }),
    });

    let settled = false;
    const migration = migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log,
      rowTimeoutMs: 5_000,
      budgetMs: 60_000,
    }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await migration;

    // The pending lookup was told to stop.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(f.subscriptions.get('deadline/hangs')).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(f.provenance.get('deadline/hangs')).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
    expect(log).toHaveBeenCalledWith(
      'Reset legacy context-graph readiness; confirmation missed its 5000ms deadline: deadline/hangs',
    );
    // The next row was not blocked by the hung one.
    expect(f.provenance.get('deadline/public')).toMatchObject({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });

  it('starts no further lookup for a row once its deadline has passed', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const f = multiRowFixture({ 'deadline/late-answer': LEGACY_SYNCED }, {
      // Answers only once aborted, as a non-cooperative lookup might.
      hasConfirmedMetaState: pendingUntilAborted(signals, true),
      isPrivateContextGraph: async () => false,
    });

    const migration = migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log: vi.fn(),
      rowTimeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await migration;
    await vi.advanceTimersByTimeAsync(1);

    expect(f.hasConfirmedMetaState).toHaveBeenCalledOnce();
    expect(f.isPrivateContextGraph).not.toHaveBeenCalled();
    expect(f.getContextGraphOnChainPolicy).not.toHaveBeenCalled();
    expect(f.provenance.get('deadline/late-answer')).toMatchObject({ durableVerified: false });
  });

  it('bounds the whole pass however many rows cannot be confirmed', async () => {
    vi.useFakeTimers();
    const rows = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`bounded/${index}`, LEGACY_SYNCED]),
    );
    const signals: AbortSignal[] = [];
    const log = vi.fn();
    const f = multiRowFixture(rows, { hasConfirmedMetaState: pendingUntilAborted(signals) });

    let settled = false;
    const migration = migrateLegacyContextGraphReadiness({
      agent: f.agent,
      store: f.store,
      log,
      rowTimeoutMs: 1_000,
      budgetMs: 3_000,
    }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBe(true);
    await migration;

    // Only the rows that fit in the budget reached a lookup; every other row
    // failed closed without one.
    expect(f.hasConfirmedMetaState).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(f.markContextGraphSubscriptionState).toHaveBeenCalledTimes(200);
    for (const id of Object.keys(rows)) {
      expect(f.provenance.get(id)).toMatchObject({ version: 1, durableVerified: false });
    }
    expect(log).toHaveBeenCalledWith(
      'Reset legacy context-graph readiness; migration budget spent before confirmation: bounded/199',
    );
  });

  it('fails closed when a lookup throws instead of rejecting', async () => {
    const f = multiRowFixture({ 'throws/sync': LEGACY_SYNCED }, {
      isCuratorOf: (() => { throw new Error('not callable'); }) as never,
    });

    await migrateLegacyContextGraphReadiness({ agent: f.agent, store: f.store, log: vi.fn() });

    expect(f.subscriptions.get('throws/sync')).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      pendingMeta: true,
    });
    expect(f.provenance.get('throws/sync')).toMatchObject({ version: 1, durableVerified: false });
  });

  it('does not reset a row that was deactivated while it was being confirmed', async () => {
    const f = multiRowFixture({ 'deactivated/mid-confirm': LEGACY_SYNCED }, {
      hasConfirmedMetaState: async (id) => {
        f.subscriptions.set(id, { ...f.subscriptions.get(id), subscribed: false });
        return false;
      },
    });

    await migrateLegacyContextGraphReadiness({ agent: f.agent, store: f.store, log: vi.fn() });

    expect(f.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(f.provenance.has('deactivated/mid-confirm')).toBe(false);
  });

  it('keeps a readiness proof persisted while the row was being confirmed', async () => {
    const f = multiRowFixture({ 'proved/mid-confirm': LEGACY_SYNCED }, {
      hasConfirmedMetaState: async (id) => {
        // PROJECT_SYNCED persistence lands a fresh proof during the await.
        f.store.setContextGraphReadinessProvenance(id, {
          version: 1,
          durableVerified: true,
          sharedMemoryVerified: true,
        });
        return false;
      },
    });

    await migrateLegacyContextGraphReadiness({ agent: f.agent, store: f.store, log: vi.fn() });

    expect(f.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(f.provenance.get('proved/mid-confirm')).toMatchObject({
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });
});

describe('readiness migration against the dashboard store', () => {
  const dirs: string[] = [];
  const dbs: DashboardDB[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function persist(db: DashboardDB, id: string, row: Row): void {
    db.upsertContextGraphSubscription({
      context_graph_id: id,
      subscribed: row.subscribed ? 1 : 0,
      synced: row.synced ? 1 : 0,
      shared_memory_synced: row.sharedMemorySynced ? 1 : 0,
      meta_synced: row.metaSynced ? 1 : 0,
      core_hosted: row.coreHosted ? 1 : 0,
      sync_scoped: 0,
      updated_at: 1,
    });
  }

  /**
   * One boot: rows restored from the durable subscription store plus rows
   * discovery catalogued. Subscription writes follow the agent's persistence
   * rule: a row with neither member nor hosting intent is deleted, which in
   * the dashboard store also deletes its readiness row.
   */
  function boot(db: DashboardDB, catalogue: Record<string, Row>) {
    const subscriptions = new Map<string, Row>(Object.entries(catalogue));
    for (const record of db.listContextGraphSubscriptions()) {
      subscriptions.set(record.context_graph_id, {
        subscribed: record.subscribed === 1,
        synced: record.synced === 1,
        sharedMemorySynced: record.shared_memory_synced === 1,
        metaSynced: record.meta_synced === 1,
        coreHosted: record.core_hosted === 1,
      });
    }
    const markContextGraphSubscriptionState = vi.fn((id: string, patch: Partial<Row>) => {
      const existing = subscriptions.get(id);
      if (!existing) return;
      const next = { ...existing, ...patch };
      subscriptions.set(id, next);
      if (next.subscribed !== true && next.coreHosted !== true) {
        db.deleteContextGraphSubscription(id);
        return;
      }
      persist(db, id, next);
    });
    const agent = {
      getSubscribedContextGraphs: () => subscriptions,
      markContextGraphSubscriptionState,
      isCuratorOf: async () => false,
      hasConfirmedMetaState: async () => false,
      isPrivateContextGraph: async () => true,
      getContextGraphOnChainPolicy: async () => ({}),
    } as unknown as DKGAgent;
    return { agent, markContextGraphSubscriptionState };
  }

  it('never deletes a subscription record, and a second boot migrates nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dkg-readiness-migration-'));
    dirs.push(dir);
    const db = new DashboardDB({ dataDir: dir });
    dbs.push(db);
    // Durable records from an earlier release: a legacy member row, a member
    // that never synced, and an inactive (dormant) durable intent.
    persist(db, 'durable/legacy-member', LEGACY_SYNCED);
    persist(db, 'durable/unsynced-member', { subscribed: true, synced: false });
    persist(db, 'durable/dormant', { subscribed: false, synced: true, sharedMemorySynced: true });
    // A catalogue row an earlier pass already stamped keeps that stamp.
    db.setContextGraphReadinessProvenance('catalogue/stamped', {
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
      updatedAt: 1,
    });
    const catalogue: Record<string, Row> = {
      'catalogue/placeholder': { subscribed: false, synced: true },
      'catalogue/stamped': { subscribed: false, synced: true },
    };
    const recordIds = () => db.listContextGraphSubscriptions().map((row) => row.context_graph_id);
    const durableIds = ['durable/dormant', 'durable/legacy-member', 'durable/unsynced-member'];

    const first = boot(db, catalogue);
    await migrateLegacyContextGraphReadiness({ agent: first.agent, store: db, log: vi.fn() });

    expect(recordIds()).toEqual(durableIds);
    expect(first.markContextGraphSubscriptionState.mock.calls.map(([id]) => id))
      .toEqual(['durable/legacy-member']);
    const afterFirstBoot = {
      legacy: db.getContextGraphReadinessProvenance('durable/legacy-member'),
      unsynced: db.getContextGraphReadinessProvenance('durable/unsynced-member'),
      stamped: db.getContextGraphReadinessProvenance('catalogue/stamped'),
    };
    expect(afterFirstBoot.legacy).toMatchObject({ version: 1, durableVerified: false });
    expect(afterFirstBoot.unsynced).toMatchObject({ version: 1, durableVerified: false });
    expect(afterFirstBoot.stamped).toMatchObject({ version: 1, updatedAt: 1 });
    expect(db.getContextGraphReadinessProvenance('durable/dormant')).toBeNull();
    expect(db.getContextGraphReadinessProvenance('catalogue/placeholder')).toBeNull();

    const second = boot(db, catalogue);
    await migrateLegacyContextGraphReadiness({ agent: second.agent, store: db, log: vi.fn() });

    expect(second.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(recordIds()).toEqual(durableIds);
    expect(db.getContextGraphReadinessProvenance('durable/legacy-member'))
      .toEqual(afterFirstBoot.legacy);
    expect(db.getContextGraphReadinessProvenance('durable/unsynced-member'))
      .toEqual(afterFirstBoot.unsynced);
    expect(db.getContextGraphReadinessProvenance('catalogue/stamped'))
      .toEqual(afterFirstBoot.stamped);
  });
});
