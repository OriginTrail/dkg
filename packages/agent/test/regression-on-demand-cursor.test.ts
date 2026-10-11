/**
 * GH-2782: the minimal cursor-lifetime detector extracted from core-fills-gap.
 * The initial fetch is represented by 19 local ordinals out of 25. Transport
 * and chain facts are fixtures; reconcile scheduling and persistence are real.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

const HEAD = 25;
const MISSING = [6, 7, 8, 9, 10, 11];
let agent: DKGAgent | undefined;
afterEach(async () => { await agent?.stop(); agent = undefined; });

describe('VM reconcile cursor follows the subscription lifetime', () => {
  it('advances an on-demand subscription through its pending ordinals without a durable write', async () => {
    const rows = new Map<string, ContextGraphSubscriptionRecord>();
    const saves: ContextGraphSubscriptionRecord[] = [];
    const chain = new MockChainAdapter();
    chain.getContextGraphKCCount = async () => BigInt(HEAD);
    agent = await DKGAgent.create({
      name: 'OnDemandCursorAdvance', chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        save: async (row) => { saves.push({ ...row }); rows.set(row.id, { ...row }); },
        delete: async (id) => { rows.delete(id); },
      },
    });
    // As in core-fills-gap: no network start or live chain is necessary for
    // the admitted subscription's cursor and durability boundary.
    const internals = agent as any;
    internals.node = { peerId: '12D3KooWCoreFillTestPeer', libp2p: { getPeers: () => [] } };
    agent.canReadContextGraph = async () => true;
    internals.healStrandedScopedKCs = async () => undefined;
    const localCgId = 'on-demand-pending';
    // CLI default unsaved intent, installed once; no later resubscription.
    const subscription = { subscribed: true, syncMode: 'on-demand', onChainId: '33', lastReconciledOrdinal: 0 };
    internals.subscribedContextGraphs.set(localCgId, subscription);
    const local = new Set(Array.from({ length: HEAD }, (_, ordinal) => ordinal)
      .filter((ordinal) => !MISSING.includes(ordinal)));
    const fetched: number[] = [];
    internals.reconcileChainOrdinal = async (_local: string, _chain: bigint, ordinal: number) => (
      local.has(ordinal) ? { status: 'reconciled', blockNumber: 100 } : {
        status: 'pending', recovery: {
          localCgId, onChainCgId: '33', ordinal,
          ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
          merkleRoot: `root-${ordinal}`, kaId: String(ordinal), reason: 'no-swm',
        },
      }
    );
    internals.recoverVmReconcileBatch = async (_local: string, _chain: bigint, targets: Array<{ ordinal: number }>) => {
      const outcomes = new Map();
      for (const { ordinal } of targets) {
        local.add(ordinal); fetched.push(ordinal);
        outcomes.set(ordinal, { status: 'reconciled', blockNumber: 100 });
      }
      return { outcomes, attemptedOrdinals: targets.map(({ ordinal }) => ordinal),
        continuationOrdinal: undefined, hasImmediateRecoveryWork: false };
    };
    expect(local.size).toBe(19);
    expect(rows.size).toBe(0);
    expect(subscription.syncMode).toBe('on-demand');
    const passes = [];
    let error: string | null = null;
    // Observe the real failure after successful setup, then execute the named
    // assertion. A thrown production error alone is not regression proof.
    try {
      while (passes.length < 10) {
        const pass = await internals.executeVmReconcileForCg(localCgId, 'periodic');
        passes.push(pass);
        if (pass.status === 'current') break;
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const observed = {
      error, fetched: [...fetched].sort((a, b) => a - b), localCount: local.size,
      steps: passes.map((pass) => [pass.watermarkBefore, pass.watermarkAfter]),
      current: passes.at(-1)?.status === 'current',
      watermark: internals.reconcileCursors.get(localCgId)?.watermark,
      subscriptionWatermark: subscription.lastReconciledOrdinal,
      saves: saves.length, rows: rows.size,
      sameSubscription: internals.subscribedContextGraphs.get(localCgId) === subscription,
    };
    process.stdout.write('REGRESSION_RUNTIME GH-2782 ' + process.version + '\n');
    process.stdout.write('REGRESSION_OBSERVATION GH-2782 ' + JSON.stringify(observed) + '\n');
    expect(observed, 'GH-2782: unsaved subscription converges without durable membership').toEqual({
      error: null, fetched: MISSING, localCount: HEAD,
      steps: [[0, 3], [3, 6], [6, HEAD]], current: true,
      watermark: HEAD, subscriptionWatermark: HEAD, saves: 0, rows: 0, sameSubscription: true,
    });
  });
});
