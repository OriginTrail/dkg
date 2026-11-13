import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { STORAGE_ACK_DECLINE_CODES } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import type {
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
} from '../src/dkg-agent-types.js';
import { peekStorageAckDemandActivations } from '../src/storage-ack-demand-activation.js';
import { storageAckRecentGraphsOf } from '../src/storage-ack-recent-graphs.js';

/**
 * A core restarts with more than a thousand saved subscription rows, as a
 * testnet core does: the activation cap (4) brings almost none back, and the
 * startup authority budget is gone before the rows hosted for StorageACKs are
 * read. A publisher then asks it to ACK into a graph created minutes ago,
 * whose row the core saved when it discovered the graph by gossip, with no
 * on-chain id yet.
 *
 * Before: the gate declined while the row waited for its paced check, and
 * that check waited up to 120 s on a name lookup the authority index could
 * not answer until its catch-up walk ended; the row then waited behind the
 * backlog in recovery. Here the name lookup never answers, as during that
 * walk.
 *
 * Now: the first request activates the row with the binding it names, and the
 * publisher's next retry is signed. After the next restart the row comes back
 * first, ahead of the hosted backlog and outside the cap.
 */

const TARGET = 'new-public-graph';
const TARGET_ID = 4242n;
const TARGET_HASH = ethers.keccak256(ethers.toUtf8Bytes(TARGET));
const STALE_ROWS = 1_272;
const HOSTED_ROWS = 260;
const REQUEST = { contextGraphId: TARGET_ID.toString(), swmGraphId: TARGET, operation: 'publish' as const };

interface State {
  node: unknown;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  contextGraphSubscriptionDormancyById: Map<string, string>;
  isContextGraphSubscriptionCommitted(id: string): boolean;
}

function savedRows(): Map<string, ContextGraphSubscriptionRecord> {
  const rows = new Map<string, ContextGraphSubscriptionRecord>();
  const pad = (n: number) => String(n).padStart(4, '0');
  // Old graphs the core subscribed to when it discovered them, never bound.
  for (let i = 0; i < STALE_ROWS; i += 1) {
    rows.set(`a-stale-${pad(i)}`, { id: `a-stale-${pad(i)}`, subscribed: true, synced: false, syncScoped: true });
  }
  // Graphs it signed ACKs for once: hosted, bound, gone from the chain now.
  for (let i = 0; i < HOSTED_ROWS; i += 1) {
    rows.set(`a-hosted-${pad(i)}`, {
      id: `a-hosted-${pad(i)}`, subscribed: false, coreHosted: true, synced: false, syncScoped: false,
      onChainId: String(100_000 + i),
    });
  }
  // The new graph, saved by discovery with no on-chain id.
  rows.set(TARGET, { id: TARGET, subscribed: true, synced: false, syncScoped: true });
  return rows;
}

const agents: DKGAgent[] = [];
const dirs: string[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const agent of agents.splice(0)) await agent.stop().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function startCore(rows: Map<string, ContextGraphSubscriptionRecord>, options: {
  dataDir?: string;
  authorityBudgetMs?: number;
  /** Reads of hosted graphs other than the target take this long. */
  slowHostedReadsMs?: number;
} = {}) {
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: TARGET_ID });
  await chain.createOnChainContextGraph({ nameHash: TARGET_HASH, accessPolicy: 0, publishPolicy: 1 });
  // The authority index is still walking: no name lookup answers.
  let endWalk!: () => void;
  const walk = new Promise<null>((resolve) => { endWalk = () => resolve(null); });
  releases.push(endWalk);
  const nameLookup = vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockImplementation(() => walk);
  if (options.slowHostedReadsMs !== undefined) {
    const isActive = chain.isContextGraphActiveOnChain.bind(chain);
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockImplementation(async (id, readOptions) => {
      if (id !== TARGET_ID) await new Promise((resolve) => { setTimeout(resolve, options.slowHostedReadsMs).unref?.(); });
      return isActive(id, readOptions);
    });
  }
  const agent = await DKGAgent.create({
    name: 'DormantRestartCore', nodeRole: 'core', chainAdapter: chain,
    ...(options.dataDir ? { dataDir: options.dataDir, store: new OxigraphStore() } : {}),
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: true,
    maxRehydratedContextGraphSubscriptions: 4,
    // 0 would mean no budget; 1 ms is spent at once, as on a busy core.
    contextGraphSubscriptionRehydrationAuthorityBudgetMs: options.authorityBudgetMs ?? 1,
    contextGraphSubscriptionStore: {
      loadAll: async () => [...rows.values()].map((row) => ({ ...row })),
      load: async (id) => { const row = rows.get(id); return row ? { ...row } : null; },
      save: async (record) => { rows.set(record.id, { ...record }); },
      delete: async (id) => { rows.delete(id); },
    },
  });
  agents.push(agent);
  const state = agent as unknown as State;
  state.node = { peerId: '12D3KooWDormantRestartCore', libp2p: { getPeers: () => [] } };
  // Network effects are inert here; authority, the cap, activation and persistence are real.
  vi.spyOn(agent, 'installContextGraphSubscription').mockImplementation((id) => state.subscribedContextGraphs.get(id)!);
  const info = vi.spyOn((agent as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info');
  const restartedAt = performance.now();
  await agent.rehydrateContextGraphSubscriptions(null);
  const rehydrationMs = performance.now() - restartedAt;
  return { agent, state, chain, nameLookup, info, rehydrationMs };
}

/** Ask like a publisher's ACK collector: again after 1, 2 and 4 s while declined. */
async function askLikeAPublisher(agent: DKGAgent) {
  const startedAt = performance.now();
  const verdicts: Array<{ atMs: number; ok: boolean; message?: string }> = [];
  for (const waitMs of [0, 1_000, 2_000, 4_000]) {
    if (waitMs > 0) await new Promise((resolve) => { setTimeout(resolve, waitMs); });
    const verdict = await agent.ensureStorageAckVmPromotion(REQUEST);
    verdicts.push({
      atMs: Math.round(performance.now() - startedAt),
      ok: verdict.ok,
      ...(verdict.ok ? {} : { message: verdict.message }),
    });
    if (verdict.ok) break;
  }
  return verdicts;
}

describe('first StorageACK for a dormant graph after a restart', { timeout: 60_000 }, () => {
  it('is signed on the publisher\'s first retry, while the name index is still catching up', async () => {
    const rows = savedRows();
    const core = await startCore(rows, { slowHostedReadsMs: 2_000 });
    expect(core.state.contextGraphSubscriptionDormancyById.get(TARGET)).toBe('activationCap');
    const dormantBefore = core.state.contextGraphSubscriptionDormancyById.size;
    expect(dormantBefore).toBe(STALE_ROWS + HOSTED_ROWS + 1);

    // The paced check of this row asks the name lookup, and waits with it.
    const pacedCheck = new AbortController();
    let pacedSettled = false;
    const paced = core.agent.resolveContextGraphSubscriptionBootstrapAuthority(TARGET, {
      allowSubscriptionFallback: false,
      signal: pacedCheck.signal,
      durableSubscriptionBinding: { contextGraphId: TARGET },
    }).finally(() => { pacedSettled = true; });

    const verdicts = await askLikeAPublisher(core.agent);

    expect(verdicts[0]).toMatchObject({ ok: false });
    expect(verdicts[0].message).toContain('not active yet (activationCap)');
    expect(verdicts.at(-1)).toMatchObject({ ok: true });
    expect(verdicts).toHaveLength(2);
    expect(verdicts[1].atMs).toBeLessThan(2_000);
    expect(pacedSettled).toBe(false);
    pacedCheck.abort();
    await paced;

    // The row is bound to the graph the request named, hosted, and still a member.
    expect(rows.get(TARGET)).toMatchObject({ onChainId: TARGET_ID.toString(), subscribed: true, coreHosted: true });
    expect(core.state.isContextGraphSubscriptionCommitted(TARGET)).toBe(true);
    // Nothing else came back: the cap still holds the backlog.
    expect(core.state.contextGraphSubscriptionDormancyById.size).toBe(dormantBefore - 1);
    expect(core.nameLookup.mock.calls.filter(([hash]) => hash === TARGET_HASH)).toHaveLength(1);
    const activated = core.info.mock.calls.map(([, message]) => String(message))
      .find((message) => message.startsWith(`Activated persisted context-graph subscription "${TARGET}"`));
    expect(activated).toMatch(/for StorageACK requests \d+ ms after the first \(was activationCap; 1 check\(s\)\)/);
  });

  it('activates a hosted row the startup budget deferred, on the first request', async () => {
    const rows = savedRows();
    rows.set(TARGET, {
      ...rows.get(TARGET)!, onChainId: TARGET_ID.toString(), coreHosted: true,
    });
    const core = await startCore(rows, { authorityBudgetMs: 300, slowHostedReadsMs: 2_000 });
    expect(core.state.contextGraphSubscriptionDormancyById.get(TARGET)).toBe('authorityUnavailable');

    const verdicts = await askLikeAPublisher(core.agent);

    expect(verdicts[0].message).toContain('not active yet (authorityUnavailable)');
    expect(verdicts.at(-1)).toMatchObject({ ok: true });
    expect(verdicts.at(-1)!.atMs).toBeLessThan(2_000);
    expect(core.state.isContextGraphSubscriptionCommitted(TARGET)).toBe(true);
  });

  it('comes back first at the next restart, ahead of the hosted backlog and outside the cap', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-dormant-restart-'));
    dirs.push(dataDir);
    const rows = savedRows();

    const before = await startCore(rows, { dataDir, slowHostedReadsMs: 2_000 });
    await expect(askLikeAPublisher(before.agent)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: true })]),
    );
    await peekStorageAckDemandActivations(before.agent)?.whenIdle();
    await storageAckRecentGraphsOf(before.agent).whenWritten();
    await before.agent.stop().catch(() => undefined);

    // Same saved rows, same data directory; the hosted backlog is slow to read.
    const after = await startCore(rows, { dataDir, authorityBudgetMs: 300, slowHostedReadsMs: 2_000 });

    expect(after.state.isContextGraphSubscriptionCommitted(TARGET)).toBe(true);
    expect(after.info.mock.calls.map(([, message]) => String(message))).toContain(
      `Restoring 1 recently ACK-requested context-graph subscription(s) first: "${TARGET}"`,
    );
    const verdict = await after.agent.ensureStorageAckVmPromotion(REQUEST);
    expect(verdict).toEqual({ ok: true });
    // The rest of the backlog stays where the budget and the cap left it.
    const reasons = [...after.state.contextGraphSubscriptionDormancyById.values()];
    expect(reasons.filter((reason) => reason === 'authorityUnavailable').length).toBe(HOSTED_ROWS + 4);
    expect(reasons.filter((reason) => reason === 'activationCap').length).toBe(STALE_ROWS - 4);

    // Without the list, the same restart leaves the hosted row behind the
    // hosted backlog, and the first request is declined.
    expect(rows.get(TARGET)).toMatchObject({ onChainId: TARGET_ID.toString(), coreHosted: true });
    const otherDir = await mkdtemp(join(tmpdir(), 'dkg-dormant-restart-'));
    dirs.push(otherDir);
    const copy = new Map([...rows].map(([id, row]) => [id, { ...row }]));
    const without = await startCore(copy, { dataDir: otherDir, authorityBudgetMs: 300, slowHostedReadsMs: 2_000 });
    expect(without.state.contextGraphSubscriptionDormancyById.get(TARGET)).toBe('authorityUnavailable');
    await expect(without.agent.ensureStorageAckVmPromotion(REQUEST)).resolves.toMatchObject({
      ok: false, code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
    });
    await peekStorageAckDemandActivations(without.agent)?.whenIdle();
    await storageAckRecentGraphsOf(without.agent).whenWritten();
  });
});
