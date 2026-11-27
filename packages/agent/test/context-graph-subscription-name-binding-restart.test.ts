import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { DEFERRED_AUTHORITY_RECOVERY_RETRY_MS } from '../src/context-graph-subscription-authority-recovery.js';
import type { ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

/**
 * A member node restarts. Its saved subscription row for a graph carries no
 * on-chain id yet, so the startup pass looks the graph's name up on chain,
 * and that lookup does not answer yet (here it fails at once). The row is
 * left dormant as `chain-name-binding-unavailable`, and with it the node's
 * gossip subscription for the graph. The lookup answers 300 ms after start.
 *
 * Before: background authority recovery asked the row again right after
 * start, before the lookup answered, and then only at its next pass, 30 s
 * later. The row stayed dormant for those 30 s, and writes the other members
 * sent by gossip in that time did not reach the node.
 *
 * Now: the row is asked again on its own, as start ends and 1 s later, and
 * activated through the same transaction recovery uses, with its binding
 * healed.
 */

const GRAPH = 'member-public-graph';
const GRAPH_ID = 4242n;
const GRAPH_HASH = ethers.keccak256(ethers.toUtf8Bytes(GRAPH));

let agent: DKGAgent | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (agent) await agent.stop().catch(() => undefined);
  agent = null;
});

describe('restart with a saved row whose chain name binding cannot be read yet', () => {
  it('asks the row again within seconds of start and activates it once the lookup answers', async () => {
    const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: GRAPH_ID });
    await chain.createOnChainContextGraph({ nameHash: GRAPH_HASH, accessPolicy: 0, publishPolicy: 1 });
    const realLookup = chain.resolveContextGraphIdByNameHash.bind(chain);
    let lookupAnswers = false;
    const lookups: number[] = [];
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockImplementation((nameHash, options) => {
      // Other startup probes call the adapter without the bounded resolver's
      // signal; they are not the lookups this test controls.
      if (!options?.signal) return Promise.resolve(null);
      lookups.push(performance.now());
      return lookupAnswers
        ? realLookup(nameHash)
        : Promise.reject(new Error('the name lookup did not answer'));
    });
    const rows = new Map<string, ContextGraphSubscriptionRecord>([[GRAPH, {
      id: GRAPH, subscribed: true, synced: true, sharedMemorySynced: true, metaSynced: true, syncScoped: true,
    }]]);
    agent = await DKGAgent.create({
      name: 'NameBindingRestartMember',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()].map((row) => ({ ...row })),
        load: async (id) => { const row = rows.get(id); return row ? { ...row } : null; },
        save: async (row) => { rows.set(row.id, { ...row }); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      syncReconcilerEnabled: false,
      vmReconcilerEnabled: false,
    });
    vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({ kind: 'available', accessPolicy: 0 });
    const log = (agent as unknown as { log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } }).log;
    const info = vi.spyOn(log, 'info');
    const warn = vi.spyOn(log, 'warn');
    const lines = (spy: typeof info): string[] => spy.mock.calls.map((call) => String(call[1]));
    const activations: unknown[] = [];
    agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, (data) => activations.push(data));

    await agent.start();
    const startedAt = performance.now();

    // The startup pass could not read the binding and left the row dormant.
    expect(lines(warn)).toContain(
      `Left persisted context-graph subscription "${GRAPH}" dormant: ` +
        'unavailable by registered-chain (chain-name-binding-unavailable)',
    );
    expect(lines(info)).toContain(
      'Asking again within seconds for 1 persisted context-graph subscription(s) ' +
        `whose chain name binding could not be read at start: "${GRAPH}"`,
    );
    // An unbound dormant row keeps no live identity: nothing subscribed.
    expect(agent.getSubscribedContextGraphs().get(GRAPH)?.subscribed ?? false).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormantReasons: { authorityUnavailable: [GRAPH] },
    });

    // Recovery's first pass runs as start ends; the lookup still fails then.
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    lookupAnswers = true;

    await vi.waitFor(
      () => expect(agent!.getSubscribedContextGraphs().get(GRAPH)).toMatchObject({
        subscribed: true,
        onChainId: GRAPH_ID.toString(),
      }),
      // Well inside recovery's next pass, which alone would have asked again.
      { timeout: DEFERRED_AUTHORITY_RECOVERY_RETRY_MS / 2, interval: 50 },
    );
    const activeAfterMs = performance.now() - startedAt;
    expect(activeAfterMs).toBeLessThan(DEFERRED_AUTHORITY_RECOVERY_RETRY_MS / 2);

    // After the startup check, the retry asked as start ended (the lookup
    // still failed) and again 1 s later.
    expect(lookups[0]).toBeLessThan(startedAt);
    expect(lookups.some((at) => at - startedAt >= 500 && at - startedAt < 2_500)).toBe(true);
    expect(lines(info)).toContainEqual(expect.stringMatching(
      new RegExp(`^Activated persisted context-graph subscription "${GRAPH}" \\d+ ms after its chain name binding could not be read at start \\(2 check\\(s\\)\\)$`),
    ));
    // Recovery left the row to the retry.
    expect(lines(info).filter((line) => line.endsWith('after authority recovery'))).toEqual([]);
    expect(activations).toEqual([{ contextGraphId: GRAPH }]);
    expect(rows.get(GRAPH)).toMatchObject({ subscribed: true, onChainId: GRAPH_ID.toString() });
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantReasons: { authorityUnavailable: [] },
    });
  }, 40_000);
});
