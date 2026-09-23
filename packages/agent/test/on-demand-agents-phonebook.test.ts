import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMetrics } from '@origintrail-official/dkg-core';
import {
  AGENTS_PHONEBOOK_CURATOR_MISS_SUPPRESSION_MS,
  AGENTS_PHONEBOOK_FETCH_BUDGET_MS,
  AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS,
  AGENTS_PHONEBOOK_FETCH_FAILURE_COOLDOWN_MS,
  AGENTS_PHONEBOOK_MIN_NETWORK_TRIPLES,
  AGENTS_PHONEBOOK_POLICY_VERDICT_TTL_MS,
  OnDemandAgentsPhonebookFetcher,
  onDemandAgentsPhonebookFor,
  peekOnDemandAgentsPhonebook,
  resolveOnDemandAgentsPhonebookFetch,
  type AgentsPhonebookAccessPolicy,
  type AgentsPhonebookCandidatePeer,
  type AgentsPhonebookPeerSyncResult,
  type OnDemandAgentsPhonebookDeps,
  type OnDemandAgentsPhonebookOptions,
} from '../src/sync/on-demand-agents-phonebook.js';

const OWNER = '0x64529c023d853371228923B4FdA5FB22F929bf51';
const OTHER_OWNER = '0x00000000000000000000000000000000000000a2';
const CG = `${OWNER}/bb-open-9c3f0`;
const CG_SAME_OWNER = `${OWNER}/bb-open-42260`;
const CG_OTHER_OWNER = `${OTHER_OWNER}/elsewhere`;

const CORE_A = '12D3KooWCoreAAAAAAAA';
const CORE_B = '12D3KooWCoreBBBBBBBB';
const CORE_C = '12D3KooWCoreCCCCCCCC';
const EDGE = '12D3KooWEdgeEEEEEEEE';
const EDGE_2 = '12D3KooWEdgeFFFFFFFF';
const EDGE_3 = '12D3KooWEdgeGGGGGGGG';

type SyncBehaviour = (
  peerId: string,
  options: { signal: AbortSignal; totalTimeoutMs: number },
) => Promise<AgentsPhonebookPeerSyncResult>;

function complete(fetchedTriples: number): AgentsPhonebookPeerSyncResult {
  return { fetchedTriples, insertedTriples: fetchedTriples, complete: true };
}

function createHarness(
  options: OnDemandAgentsPhonebookOptions & {
    peers?: AgentsPhonebookCandidatePeer[];
    subscribed?: string[];
    policies?: Record<string, AgentsPhonebookAccessPolicy>;
    /** Wallets (lower-cased) a successful sync adds to the phonebook. */
    syncAddsWallets?: string[];
    sync?: SyncBehaviour;
  } = {},
) {
  let now = 10_000_000;
  const phonebook = new Set<string>();
  const subscriptions = new Set(options.subscribed ?? [CG]);
  const policies = new Map(Object.entries(options.policies ?? {}));
  const peers: AgentsPhonebookCandidatePeer[] = [...(options.peers ?? [{ peerId: CORE_A, core: true }])];
  const syncCalls: Array<{ peerId: string; totalTimeoutMs: number; signal: AbortSignal }> = [];
  const resolvedBatches: string[][] = [];
  const info: string[] = [];
  const debug: string[] = [];
  let enabled = true;
  const syncAddsWallets = options.syncAddsWallets ?? [OWNER.toLowerCase()];
  const sync: SyncBehaviour = options.sync ?? (async () => {
    for (const wallet of syncAddsWallets) phonebook.add(wallet);
    return complete(75_141);
  });
  const deps: OnDemandAgentsPhonebookDeps = {
    isEnabled: vi.fn(() => enabled),
    remoteCuratorWallet: (contextGraphId) => /^(0x[0-9a-fA-F]{40})\/.+$/.exec(contextGraphId)?.[1] ?? null,
    isActiveSubscription: (contextGraphId) => subscriptions.has(contextGraphId),
    phonebookHasWallet: vi.fn(async (wallet: string) => phonebook.has(wallet.toLowerCase())),
    readAccessPolicy: vi.fn(async (contextGraphId: string) => policies.get(contextGraphId) ?? 'public'),
    listConnectedPeers: () => peers,
    preparePeer: vi.fn(async () => true),
    syncAgentsFromPeer: vi.fn(async (peerId: string, syncOptions: { signal: AbortSignal; totalTimeoutMs: number }) => {
      syncCalls.push({ peerId, ...syncOptions });
      return sync(peerId, syncOptions);
    }),
    onCuratorsResolved: (contextGraphIds) => { resolvedBatches.push([...contextGraphIds]); },
    logInfo: (message) => { info.push(message); },
    logDebug: (message) => { debug.push(message); },
  };
  const fetcher = new OnDemandAgentsPhonebookFetcher(deps, {
    now: () => now,
    noPeerRetryMs: 5,
    ...options,
  });
  return {
    fetcher,
    deps,
    phonebook,
    subscriptions,
    policies,
    peers,
    syncCalls,
    resolvedBatches,
    info,
    debug,
    advance(ms: number) { now += ms; },
    setEnabled(value: boolean) { enabled = value; },
  };
}

/**
 * Hold the fetch's post-walk phonebook check: the owner's second lookup (the
 * first is the qualification check). The peer walk is complete by then.
 */
function holdPostWalkOwnerCheck(h: ReturnType<typeof createHarness>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  let ownerLookups = 0;
  vi.mocked(h.deps.phonebookHasWallet).mockImplementation(async (wallet: string) => {
    if (wallet.toLowerCase() === OWNER.toLowerCase()) {
      ownerLookups += 1;
      if (ownerLookups === 2) {
        held = true;
        await released;
      }
    }
    return h.phonebook.has(wallet.toLowerCase());
  });
  return { release: () => release(), isHeld: () => held };
}

describe('resolveOnDemandAgentsPhonebookFetch', () => {
  it('is on by default on an Edge and off where the phonebook already syncs on connect', () => {
    expect(resolveOnDemandAgentsPhonebookFetch({})).toBe(true);
    expect(resolveOnDemandAgentsPhonebookFetch({ nodeRole: 'edge' })).toBe(true);
    expect(resolveOnDemandAgentsPhonebookFetch({ nodeRole: 'core' })).toBe(false);
    expect(resolveOnDemandAgentsPhonebookFetch({ nodeRole: 'edge', envValue: '1' })).toBe(false);
    expect(resolveOnDemandAgentsPhonebookFetch({ nodeRole: 'edge', configValue: true })).toBe(false);
    // A Core that turned the on-connect sync off falls back to the on-demand fetch.
    expect(resolveOnDemandAgentsPhonebookFetch({ nodeRole: 'core', envValue: '0' })).toBe(true);
  });

  it('lets the environment win over config for the kill switch', () => {
    expect(resolveOnDemandAgentsPhonebookFetch({ onDemandConfigValue: false })).toBe(false);
    expect(resolveOnDemandAgentsPhonebookFetch({ onDemandEnvValue: '0', onDemandConfigValue: true })).toBe(false);
    expect(resolveOnDemandAgentsPhonebookFetch({ onDemandEnvValue: 'off' })).toBe(false);
    expect(resolveOnDemandAgentsPhonebookFetch({ onDemandEnvValue: '1', onDemandConfigValue: false })).toBe(true);
    // An unrecognized value is unset, not truthy.
    expect(resolveOnDemandAgentsPhonebookFetch({ onDemandEnvValue: 'maybe', onDemandConfigValue: false })).toBe(false);
  });
});

describe('OnDemandAgentsPhonebookFetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coalesces graphs of one owner into exactly one bounded fetch and reports the resolved curator', async () => {
    const h = createHarness({ subscribed: [CG, CG_SAME_OWNER] });

    h.fetcher.request(CG, 'subscribe');
    h.fetcher.request(CG_SAME_OWNER, 'vm-reconcile');
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();

    expect(h.syncCalls.map(({ peerId }) => peerId)).toEqual([CORE_A]);
    expect(h.syncCalls[0]!.totalTimeoutMs).toBeGreaterThan(0);
    expect(h.syncCalls[0]!.totalTimeoutMs).toBeLessThanOrEqual(AGENTS_PHONEBOOK_FETCH_BUDGET_MS);
    expect(h.resolvedBatches).toEqual([[CG, CG_SAME_OWNER]]);
    expect(h.info).toHaveLength(1);
    expect(h.info[0]).toContain('trigger=subscribe');
    expect(h.info[0]).toContain(`graph=${CG} (+1)`);
    expect(h.info[0]).toContain(`peers=[${CORE_A.slice(-8)}:core:complete:75141]`);
    expect(h.info[0]).toContain('fetched=75141 inserted=75141 durationMs=');
    expect(h.info[0]).toContain('curatorResolved=2/2 outcome=complete');
    expect(h.info[0]).toContain(`nextFetchInMs=${AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS}`);
    expect(h.info[0]).toMatch(/durationMs=\d+/);
  });

  it('asks known Cores first and stops after the first complete Core phonebook', async () => {
    const h = createHarness({
      peers: [
        { peerId: EDGE, core: false },
        { peerId: CORE_B, core: true },
        { peerId: CORE_A, core: true },
      ],
      // The phonebook does not contain the owner: only the complete Core stops the walk.
      syncAddsWallets: [],
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    expect(h.syncCalls.map(({ peerId }) => peerId)).toEqual([CORE_A]);
  });

  it('does not take an empty "complete" Core answer for the network phonebook', async () => {
    // A just-started or lean Core answers a full scan as complete with no rows.
    const h = createHarness({
      peers: [
        { peerId: CORE_A, core: true },
        { peerId: CORE_B, core: true },
      ],
      syncAddsWallets: [],
      sync: async () => complete(0),
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    // The empty answer neither ends the walk nor counts as a complete fetch...
    expect(h.syncCalls.map(({ peerId }) => peerId)).toEqual([CORE_A, CORE_B]);
    expect(h.info[0]).toContain('outcome=empty');
    expect(h.info[0]).toContain(`nextFetchInMs=${AGENTS_PHONEBOOK_FETCH_FAILURE_COOLDOWN_MS}`);

    // ...and the graph is not suppressed for hours: it asks again after the
    // short cooldown.
    h.advance(AGENTS_PHONEBOOK_FETCH_FAILURE_COOLDOWN_MS);
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(4);
  });

  it('needs a real phonebook, not a lean Core answer, before suppressing a graph', async () => {
    const leanTriples = 60;
    const h = createHarness({
      peers: [
        { peerId: CORE_A, core: true },
        { peerId: CORE_B, core: true },
      ],
      syncAddsWallets: [],
      sync: async (peerId) => complete(
        peerId === CORE_A ? leanTriples : AGENTS_PHONEBOOK_MIN_NETWORK_TRIPLES,
      ),
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    // The lean Core does not end the walk; the next Core's phonebook does.
    expect(h.syncCalls.map(({ peerId }) => peerId)).toEqual([CORE_A, CORE_B]);
    expect(h.info[0]).toContain('curatorResolved=0/1 outcome=complete');
    h.advance(AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS);
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(2);

    // Only lean answers: a partial fetch, the ordinary cooldown, no suppression.
    const lean = createHarness({
      syncAddsWallets: [],
      sync: async () => complete(leanTriples),
    });
    lean.fetcher.request(CG, 'subscribe');
    await lean.fetcher.whenIdle();
    expect(lean.info[0]).toContain('outcome=partial');
    lean.advance(AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS);
    lean.fetcher.request(CG, 'vm-reconcile');
    await lean.fetcher.whenIdle();
    expect(lean.syncCalls).toHaveLength(2);
  });

  it('moves to the next peer after a failed one and never exceeds the peer cap', async () => {
    const h = createHarness({
      peers: [
        { peerId: CORE_A, core: true },
        { peerId: CORE_B, core: true },
        { peerId: CORE_C, core: true },
        { peerId: EDGE, core: false },
      ],
      sync: async () => { throw new Error('The stream has been reset'); },
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    expect(h.syncCalls.map(({ peerId }) => peerId)).toEqual([CORE_A, CORE_B, CORE_C]);
    expect(h.resolvedBatches).toEqual([]);
    expect(h.info[0]).toContain('outcome=failed');
    expect(h.info[0]).toContain(`nextFetchInMs=${AGENTS_PHONEBOOK_FETCH_FAILURE_COOLDOWN_MS}`);
    expect(h.debug.some((line) => line.includes('The stream has been reset'))).toBe(true);
  });

  it('skips a peer that fails admission or has no sync protocol without spending the peer cap', async () => {
    const h = createHarness({
      peers: [
        { peerId: CORE_A, core: true },
        { peerId: CORE_B, core: true },
      ],
    });
    vi.mocked(h.deps.preparePeer).mockImplementation(async (peerId) => {
      if (peerId === CORE_A) throw new Error('identity probe failed');
      return true;
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    expect(h.syncCalls.map(({ peerId }) => peerId)).toEqual([CORE_B]);
  });

  it('keeps walking past partial or non-Core phonebooks without the owner and stops once it resolves', async () => {
    const h = createHarness({
      maxPeers: 5,
      peers: [
        { peerId: EDGE_3, core: false },
        { peerId: EDGE_2, core: false },
        { peerId: EDGE, core: false },
        { peerId: CORE_A, core: true },
      ],
      sync: async (peerId) => {
        // A Core cut short by its budget, then an Edge whose small phonebook is
        // complete but lacks the owner; neither may end the walk.
        if (peerId === CORE_A) return { fetchedTriples: 900, insertedTriples: 900, complete: false };
        if (peerId === EDGE) return complete(40);
        h.phonebook.add(OWNER.toLowerCase());
        return complete(60);
      },
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    expect(h.syncCalls.map(({ peerId }) => peerId)).toEqual([CORE_A, EDGE, EDGE_2]);
    expect(h.resolvedBatches).toEqual([[CG]]);
    expect(h.info[0]).toContain(`${CORE_A.slice(-8)}:core:partial:900`);
    expect(h.info[0]).toContain(`${EDGE.slice(-8)}:peer:complete:40`);
    expect(h.info[0]).toContain('outcome=complete');
  });

  it('reports a partial fetch when data arrived but the owner is still unknown', async () => {
    const h = createHarness({
      maxPeers: 1,
      sync: async () => ({ fetchedTriples: 900, insertedTriples: 900, complete: false }),
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    expect(h.info[0]).toContain('curatorResolved=0/1 outcome=partial');
    expect(h.info[0]).toContain(`nextFetchInMs=${AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS}`);
    expect(h.resolvedBatches).toEqual([]);
  });

  it('does not repeat inside the cooldown, and fetches again once it expires', async () => {
    const h = createHarness({ subscribed: [CG, CG_OTHER_OWNER] });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);

    // Another graph whose owner is still unknown asks inside the cooldown.
    h.advance(AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS - 1);
    h.fetcher.request(CG_OTHER_OWNER, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);
    expect(h.deps.phonebookHasWallet).not.toHaveBeenCalledWith(OTHER_OWNER, expect.anything());

    h.advance(1);
    h.fetcher.request(CG_OTHER_OWNER, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(2);
    expect(h.info[1]).toContain('trigger=vm-reconcile');
  });

  it('spaces a failed fetch by the shorter failure cooldown', async () => {
    let fail = true;
    const h = createHarness({
      sync: async () => {
        if (fail) throw new Error('reset');
        h.phonebook.add(OWNER.toLowerCase());
        return complete(10);
      },
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);

    fail = false;
    h.advance(AGENTS_PHONEBOOK_FETCH_FAILURE_COOLDOWN_MS - 1);
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);

    h.advance(1);
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(2);
    expect(h.resolvedBatches).toEqual([[CG]]);
  });

  it('does nothing when the kill switch is off', async () => {
    const h = createHarness();
    h.setEnabled(false);

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    expect(h.deps.phonebookHasWallet).not.toHaveBeenCalled();
    expect(h.deps.readAccessPolicy).not.toHaveBeenCalled();
    expect(h.syncCalls).toEqual([]);
  });

  it('never fetches for a graph that is not public on chain', async () => {
    const h = createHarness({ policies: { [CG]: 'not-public' } });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();

    expect(h.syncCalls).toEqual([]);
    // The private verdict is reused instead of read on every reconcile pass.
    expect(h.deps.readAccessPolicy).toHaveBeenCalledTimes(1);

    h.advance(AGENTS_PHONEBOOK_POLICY_VERDICT_TTL_MS);
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.deps.readAccessPolicy).toHaveBeenCalledTimes(2);
    expect(h.syncCalls).toEqual([]);
  });

  it('treats an unanswered policy read as no verdict and reads again next time', async () => {
    const h = createHarness({ policies: { [CG]: 'unknown' } });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toEqual([]);

    h.policies.set(CG, 'public');
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.deps.readAccessPolicy).toHaveBeenCalledTimes(2);
    expect(h.syncCalls).toHaveLength(1);
  });

  it('ignores graphs that cannot use the phonebook or already resolve their owner', async () => {
    const h = createHarness({ subscribed: [CG, 'legacy-global-cg', 'agents', CG_OTHER_OWNER] });
    h.phonebook.add(OTHER_OWNER.toLowerCase());

    h.fetcher.request('legacy-global-cg', 'vm-reconcile');
    h.fetcher.request('agents', 'subscribe');
    h.fetcher.request(CG_OTHER_OWNER, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toEqual([]);
    expect(h.deps.readAccessPolicy).not.toHaveBeenCalled();

    // Not (or no longer) subscribed.
    h.subscriptions.delete(CG);
    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toEqual([]);
  });

  it('waits for a usable peer without starting a cooldown, then fetches once one appears', async () => {
    const h = createHarness({ peers: [] });

    h.fetcher.request(CG, 'startup');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toEqual([]);
    expect(h.debug.some((line) => line.includes('no usable connected peer'))).toBe(true);
    expect(h.info).toEqual([]);

    h.peers.push({ peerId: CORE_A, core: true });
    await vi.waitFor(() => expect(h.syncCalls).toHaveLength(1));
    await h.fetcher.whenIdle();
    expect(h.info[0]).toContain('trigger=startup');
    expect(h.resolvedBatches).toEqual([[CG]]);
  });

  it('starts at once when another graph asks while a re-check is pending, and cancels that re-check', async () => {
    const h = createHarness({ peers: [], noPeerRetryMs: 60_000, subscribed: [CG, CG_SAME_OWNER] });

    h.fetcher.request(CG, 'startup');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toEqual([]);

    h.peers.push({ peerId: CORE_A, core: true });
    h.fetcher.request(CG_SAME_OWNER, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);
    expect(h.resolvedBatches).toEqual([[CG, CG_SAME_OWNER]]);
    // The first trigger labels the fetch.
    expect(h.info[0]).toContain('trigger=startup');
  });

  it('bounds the no-peer re-check and lets a later trigger ask again', async () => {
    const h = createHarness({ peers: [], noPeerMaxRetries: 2 });

    h.fetcher.request(CG, 'startup');
    await vi.waitFor(() => {
      expect(h.debug.filter((line) => line.includes('no usable connected peer'))).toHaveLength(3);
    });
    // Give a fourth re-check the chance to fire: it must not.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.fetcher.whenIdle();
    expect(h.debug.filter((line) => line.includes('no usable connected peer'))).toHaveLength(3);

    h.peers.push({ peerId: CORE_A, core: true });
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);
  });

  it('stops asking for hours for a graph whose owner a complete Core phonebook lacks', async () => {
    const h = createHarness({ subscribed: [CG, CG_OTHER_OWNER], syncAddsWallets: [] });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);
    expect(h.info[0]).toContain('curatorResolved=0/1 outcome=complete');
    expect(h.resolvedBatches).toEqual([]);

    // After the ordinary cooldown the missing graph stays quiet...
    h.advance(AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS);
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);
    // ...while another graph may still fetch.
    h.fetcher.request(CG_OTHER_OWNER, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(2);

    h.advance(AGENTS_PHONEBOOK_CURATOR_MISS_SUPPRESSION_MS);
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(3);
  });

  it('shares one wall-clock budget across peers and aborts a peer that outlives it', async () => {
    const h = createHarness({
      budgetMs: 25,
      peers: [
        { peerId: CORE_A, core: true },
        { peerId: CORE_B, core: true },
      ],
      sync: (_peerId, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    expect(h.syncCalls.map(({ peerId }) => peerId)).toEqual([CORE_A]);
    expect(h.syncCalls[0]!.signal.aborted).toBe(true);
    expect(h.syncCalls[0]!.totalTimeoutMs).toBeLessThanOrEqual(25);
    expect(h.info[0]).toContain('outcome=failed');
  });

  it('drops a graph that qualifies after the fetch read its list instead of parking it', async () => {
    const h = createHarness({ subscribed: [CG, CG_OTHER_OWNER] });
    const postWalk = holdPostWalkOwnerCheck(h);

    h.fetcher.request(CG, 'subscribe');
    await vi.waitFor(() => expect(postWalk.isHeld()).toBe(true));
    // Qualifies while the finished fetch is still reporting.
    h.fetcher.request(CG_OTHER_OWNER, 'vm-reconcile');
    await vi.waitFor(() => expect(h.deps.readAccessPolicy).toHaveBeenCalledWith(
      CG_OTHER_OWNER,
      expect.anything(),
    ));
    postWalk.release();
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);

    h.advance(AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS);
    h.fetcher.request(CG_OTHER_OWNER, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(2);
  });

  it('reports nothing and schedules no recovery when closed after the peer walk', async () => {
    const add = vi.spyOn(getMetrics().agentsPhonebookFetchTotal, 'add');
    const h = createHarness();
    const postWalk = holdPostWalkOwnerCheck(h);

    h.fetcher.request(CG, 'subscribe');
    await vi.waitFor(() => expect(postWalk.isHeld()).toBe(true));
    // stop() closes the fetcher while the finished walk is still reporting.
    const closing = h.fetcher.close();
    postWalk.release();
    await closing;

    expect(h.syncCalls).toHaveLength(1);
    expect(h.info).toEqual([]);
    expect(h.resolvedBatches).toEqual([]);
    expect(add.mock.calls.filter(([, attributes]) => (
      attributes !== undefined && 'curator_resolved' in attributes
    ))).toEqual([]);
  });

  it('close aborts an in-flight fetch without reporting it, and reopen admits requests again', async () => {
    const h = createHarness({
      sync: (_peerId, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });

    h.fetcher.request(CG, 'subscribe');
    await vi.waitFor(() => expect(h.syncCalls).toHaveLength(1));
    await h.fetcher.close();
    expect(h.syncCalls[0]!.signal.aborted).toBe(true);
    expect(h.info).toEqual([]);

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);

    h.fetcher.reopen();
    vi.mocked(h.deps.syncAgentsFromPeer).mockImplementation(async (peerId, syncOptions) => {
      h.syncCalls.push({ peerId, ...syncOptions });
      h.phonebook.add(OWNER.toLowerCase());
      return complete(5);
    });
    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(2);
    expect(h.resolvedBatches).toEqual([[CG]]);
  });

  it('never throws into its caller, even when a dependency does', async () => {
    const h = createHarness();
    vi.mocked(h.deps.isEnabled).mockImplementation(() => { throw new Error('config unreadable'); });
    expect(() => h.fetcher.request(CG, 'subscribe')).not.toThrow();

    vi.mocked(h.deps.isEnabled).mockReturnValue(true);
    vi.mocked(h.deps.phonebookHasWallet).mockRejectedValue(new Error('store busy'));
    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toEqual([]);
    expect(h.debug.some((line) => line.includes('store busy'))).toBe(true);
  });

  it('counts fetches by trigger, outcome and whether a wanted curator resolved', async () => {
    const add = vi.spyOn(getMetrics().agentsPhonebookFetchTotal, 'add');
    const record = vi.spyOn(getMetrics().agentsPhonebookFetchDurationMs, 'record');
    const h = createHarness();

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    // Without a meter provider every instrument is one shared no-op, so keep
    // only the calls carrying this module's labels.
    const fetchCounts = add.mock.calls.filter(([, attributes]) => (
      attributes !== undefined && 'curator_resolved' in attributes
    ));
    expect(fetchCounts).toEqual([
      [1, { trigger: 'subscribe', outcome: 'complete', curator_resolved: 'true' }],
    ]);
    const durations = record.mock.calls.filter(([, attributes]) => (
      attributes?.['trigger'] === 'subscribe' && attributes?.['outcome'] === 'complete'
    ));
    expect(durations).toHaveLength(1);
  });

  it('drops a graph whose checks finish inside the cooldown, so it can ask again later', async () => {
    let releasePolicy!: () => void;
    let blockOnce = true;
    const h = createHarness({ subscribed: [CG, CG_OTHER_OWNER] });
    vi.mocked(h.deps.readAccessPolicy).mockImplementation(async (contextGraphId) => {
      if (contextGraphId === CG_OTHER_OWNER && blockOnce) {
        blockOnce = false;
        await new Promise<void>((resolve) => { releasePolicy = resolve; });
      }
      return 'public';
    });

    h.fetcher.request(CG_OTHER_OWNER, 'vm-reconcile');
    await vi.waitFor(() => expect(releasePolicy).toBeTypeOf('function'));
    h.fetcher.request(CG, 'subscribe');
    await vi.waitFor(() => expect(h.info).toHaveLength(1));
    // The fetch for CG is done and cooling down when this check completes.
    releasePolicy();
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(1);

    h.advance(AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS);
    h.fetcher.request(CG_OTHER_OWNER, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.syncCalls).toHaveLength(2);
  });

  it('recovers from an unexpected fetch error through the bounded re-check', async () => {
    const h = createHarness();
    const listConnectedPeers = h.deps.listConnectedPeers;
    let calls = 0;
    h.deps.listConnectedPeers = () => {
      calls += 1;
      if (calls === 1) throw new Error('connection manager closed');
      return listConnectedPeers();
    };

    h.fetcher.request(CG, 'subscribe');
    await vi.waitFor(() => expect(h.syncCalls).toHaveLength(1));
    await h.fetcher.whenIdle();
    expect(h.debug.some((line) => line.includes('fetch stopped: connection manager closed'))).toBe(true);
    expect(h.resolvedBatches).toEqual([[CG]]);
  });

  it('keeps fetching when the metrics exporter throws', async () => {
    vi.spyOn(getMetrics().agentsPhonebookFetchTotal, 'add').mockImplementation(() => {
      throw new Error('exporter down');
    });
    const h = createHarness();

    h.fetcher.request(CG, 'subscribe');
    await h.fetcher.whenIdle();

    expect(h.info[0]).toContain('outcome=complete');
    expect(h.resolvedBatches).toEqual([[CG]]);
  });

  it('bounds its per-graph state', async () => {
    const graphs = [CG, CG_SAME_OWNER, CG_OTHER_OWNER];
    const h = createHarness({
      subscribed: graphs,
      maxStateEntries: 2,
      policies: Object.fromEntries(graphs.map((graph) => [graph, 'not-public'])),
    });

    for (const graph of graphs) {
      h.fetcher.request(graph, 'vm-reconcile');
      await h.fetcher.whenIdle();
    }
    expect(h.deps.readAccessPolicy).toHaveBeenCalledTimes(3);
    // The oldest verdict was evicted and is read again; the newest is reused.
    h.fetcher.request(CG, 'vm-reconcile');
    await h.fetcher.whenIdle();
    h.fetcher.request(CG_OTHER_OWNER, 'vm-reconcile');
    await h.fetcher.whenIdle();
    expect(h.deps.readAccessPolicy).toHaveBeenCalledTimes(4);
    expect(h.syncCalls).toEqual([]);
  });

  it('keeps one fetcher per host', () => {
    const host = {};
    expect(peekOnDemandAgentsPhonebook(host)).toBeUndefined();
    const create = vi.fn(() => createHarness().fetcher);
    const first = onDemandAgentsPhonebookFor(host, create);
    expect(onDemandAgentsPhonebookFor(host, create)).toBe(first);
    expect(peekOnDemandAgentsPhonebook(host)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
